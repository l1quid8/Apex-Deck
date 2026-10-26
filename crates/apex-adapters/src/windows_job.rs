//! A Windows process tree owned by a non-inheritable, kill-on-close Job handle.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

pub(crate) struct Job(OwnedHandle);

impl Job {
    pub(crate) fn spawn(
        command: &mut tokio::process::Command,
    ) -> io::Result<(tokio::process::Child, Self)> {
        protect_owner()?;
        let job = Self::new()?;
        job.spawn_suspended(command)
    }

    fn new() -> io::Result<Self> {
        // No name or inheritable handle: only this owner keeps the job alive.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw.cast()) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the buffer is the exact type and size requested by the API.
        if unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn spawn_suspended(
        self,
        command: &mut tokio::process::Command,
    ) -> io::Result<(tokio::process::Child, Self)> {
        let job = self;
        // Suspend before user code runs. Attaching an already running launcher
        // races its first child, which would escape process-tree cleanup.
        command
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let result = (|| {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("the suspended worker has no process handle"))?;
            if unsafe { AssignProcessToJobObject(job.handle(), process.cast()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            resume(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("the suspended worker has no PID"))?,
            )
        })();
        if let Err(error) = result {
            // Fail closed: neither an unattached nor a suspended worker can
            // survive an assignment/resume failure.
            let _ = child.start_kill();
            let _ = job.terminate();
            return Err(io::Error::other(format!(
                "could not own the Windows worker process tree: {error}"
            )));
        }
        Ok((child, job))
    }

    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle().cast()
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn active(&self) -> io::Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: valid owned handle and correctly sized output buffer.
        if unsafe {
            QueryInformationJobObject(
                self.handle(),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses)
    }
}

fn protect_owner() -> io::Result<()> {
    // A lifetime Job covers the interval between CreateProcess and assignment
    // to the per-worker Job. Even an owner crash in that interval must not
    // orphan a suspended worker. Children inherit this outer Job atomically.
    // Static handles live until OS process teardown, when kill-on-close ends
    // every remaining descendant. Per-worker nested Jobs still own Stop.
    static OWNER: std::sync::OnceLock<Result<Job, String>> = std::sync::OnceLock::new();
    OWNER
        .get_or_init(|| {
            let job = Job::new().map_err(|e| e.to_string())?;
            if unsafe { AssignProcessToJobObject(job.handle(), GetCurrentProcess()) } == 0 {
                return Err(io::Error::last_os_error().to_string());
            }
            Ok(job)
        })
        .as_ref()
        .map(|_| ())
        .map_err(|why| {
            io::Error::other(format!("could not establish Windows owner lifetime: {why}"))
        })
}

fn resume(pid: u32) -> io::Result<()> {
    // Stable std/tokio exposes the process handle, but not its initial thread
    // handle. A CREATE_SUSPENDED process cannot create any additional threads
    // itself, so locate its one initial thread and resume it after assignment.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.cast()) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle().cast(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    entry.th32ThreadID,
                )
            };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread.cast()) };
            // A thread id can be reused between the snapshot and OpenThread.
            if unsafe { GetProcessIdOfThread(thread.as_raw_handle().cast()) } != pid {
                return Err(io::Error::other(
                    "the suspended worker's thread identity changed",
                ));
            }
            let previous = unsafe { ResumeThread(thread.as_raw_handle().cast()) };
            return match previous {
                1 => Ok(()),
                u32::MAX => Err(io::Error::last_os_error()),
                _ => Err(io::Error::other(
                    "the worker's initial suspend count changed",
                )),
            };
        }
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        found = unsafe { Thread32Next(snapshot.as_raw_handle().cast(), &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(error);
    }
    Err(io::Error::other(
        "could not find the suspended worker's initial thread",
    ))
}

#[cfg(test)]
mod tests {
    use crate::owned_process::Registry;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use tokio::process::Command;

    fn worker(marker: &std::path::Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "windows_job::tests::worker_process",
                "--nocapture",
            ])
            .env("APEX_JOB_TEST_MARKER", marker)
            .env("APEX_JOB_TEST_MODE", mode);
        command
    }

    // This subprocess fixture uses Rust instead of relying on a particular
    // shell being installed on the Windows runner.
    #[test]
    #[ignore = "subprocess fixture"]
    fn worker_process() {
        let marker = PathBuf::from(std::env::var_os("APEX_JOB_TEST_MARKER").unwrap());
        let mode = std::env::var("APEX_JOB_TEST_MODE").unwrap();
        if mode == "owner" || mode == "owner_before_assignment" {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                if mode == "owner_before_assignment" {
                    super::protect_owner().unwrap();
                    // Deliberately stop before per-worker Job assignment.
                    let _child = worker(&marker, "leaf").spawn().unwrap();
                    tokio::time::sleep(Duration::from_secs(60)).await;
                } else {
                    let _child = Registry::default()
                        .spawn(&mut worker(&marker, "leaf"))
                        .unwrap();
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            });
            return;
        }
        if mode != "leaf" {
            let mut leaf = std::process::Command::new(std::env::current_exe().unwrap());
            leaf.args([
                "--ignored",
                "--exact",
                "windows_job::tests::worker_process",
                "--nocapture",
            ])
            .env("APEX_JOB_TEST_MODE", "leaf");
            let _child = leaf.spawn().unwrap();
            if mode == "exit" {
                return;
            }
        } else {
            std::fs::write(marker, std::process::id().to_string()).unwrap();
        }
        std::thread::sleep(Duration::from_secs(60));
    }

    async fn tree(mode: &str) -> (Registry, crate::owned_process::OwnedChild, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let marker = std::env::temp_dir().join(format!(
            "apx-job-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let registry = Registry::default();
        let child = registry.spawn(&mut worker(&marker, mode)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !std::fs::read_to_string(&marker).is_ok_and(|text| text.parse::<u32>().is_ok()) {
            assert!(Instant::now() < deadline, "descendant did not start");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        (registry, child, marker)
    }

    async fn gone(marker: PathBuf) {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        // Holding the handle avoids mistaking a reused PID for this process.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER as i32)
            );
        } else {
            let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
            let deadline = Instant::now() + Duration::from_secs(5);
            while unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) } != 0 {
                assert!(
                    Instant::now() < deadline,
                    "descendant {pid} survived cleanup"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        std::fs::remove_file(marker).unwrap();
    }

    #[tokio::test]
    async fn registry_stop_kills_the_whole_windows_tree() {
        let (registry, mut child, marker) = tree("parent").await;
        assert!(registry.terminate_all().await.unwrap());
        child.wait().await.unwrap();
        gone(marker).await;
        drop(child);
        assert!(!registry.terminate_all().await.unwrap());
    }

    #[tokio::test]
    async fn dropping_an_owned_child_kills_descendants_even_after_its_leader_exits() {
        let (_registry, mut child, marker) = tree("exit").await;
        child.wait().await.unwrap();
        drop(child);
        gone(marker).await;
    }

    #[tokio::test]
    async fn owner_crash_closes_the_job_and_kills_its_workers() {
        owner_crash("owner").await;
    }

    #[tokio::test]
    async fn owner_crash_before_worker_assignment_leaves_no_orphan() {
        owner_crash("owner_before_assignment").await;
    }

    async fn owner_crash(mode: &str) {
        let marker =
            std::env::temp_dir().join(format!("apx-job-crash-{mode}-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let mut owner = worker(&marker, mode).as_std_mut().spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !std::fs::read_to_string(&marker).is_ok_and(|text| text.parse::<u32>().is_ok()) {
            if Instant::now() >= deadline {
                let _ = owner.kill();
                let _ = owner.wait();
                panic!("owner's worker did not start");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        owner.kill().unwrap();
        owner.wait().unwrap();
        gone(marker).await;
    }
}
