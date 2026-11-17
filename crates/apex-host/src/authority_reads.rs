//! Share only an active protected read. Completed responses are never retained.
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, RwLock, RwLockWriteGuard, Weak},
};

type SharedResult = Result<Vec<u8>, (io::ErrorKind, String)>;

#[derive(Default)]
struct Pending {
    result: Mutex<Option<SharedResult>>,
    ready: Condvar,
}

#[derive(Default)]
pub(crate) struct ReadGate {
    admission: Mutex<()>,
    access: RwLock<()>,
    pending: Mutex<Option<Arc<Pending>>>,
}

fn poisoned() -> io::Error {
    io::Error::other("Protected document read lock poisoned")
}

impl ReadGate {
    pub(crate) fn read(&self, load: impl FnOnce() -> io::Result<Vec<u8>>) -> io::Result<Vec<u8>> {
        let admission = self.admission.lock().map_err(|_| poisoned())?;
        let _access = self.access.read().map_err(|_| poisoned())?;
        drop(admission);
        let (pending, owner) = {
            let mut active = self.pending.lock().map_err(|_| poisoned())?;
            match active.as_ref() {
                Some(pending) => (pending.clone(), false),
                None => {
                    let pending = Arc::new(Pending::default());
                    *active = Some(pending.clone());
                    (pending, true)
                }
            }
        };
        if owner {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(load));
            let shared = match &outcome {
                Ok(Ok(bytes)) => Ok(bytes.clone()),
                Ok(Err(error)) => Err((error.kind(), error.to_string())),
                Err(_) => Err((io::ErrorKind::Interrupted, "Protected document read did not finish".into())),
            };
            // Retire the flight before waking its existing readers. A new
            // caller must issue a fresh broker read after this one completes.
            *self.pending.lock().unwrap_or_else(|error| error.into_inner()) = None;
            *pending.result.lock().unwrap_or_else(|error| error.into_inner()) = Some(shared);
            pending.ready.notify_all();
            if let Err(panic) = outcome {
                std::panic::resume_unwind(panic);
            }
        }
        let mut result = pending.result.lock().map_err(|_| poisoned())?;
        while result.is_none() {
            result = pending.ready.wait(result).map_err(|_| poisoned())?;
        }
        match result.as_ref().unwrap() {
            Ok(bytes) => Ok(bytes.clone()),
            Err((kind, message)) => Err(io::Error::new(*kind, message.clone())),
        }
    }

    pub(crate) fn write(&self) -> io::Result<RwLockWriteGuard<'_, ()>> {
        // A waiting writer holds admission so new readers cannot extend
        // its wait on platforms whose RwLock favors readers.
        let admission = self.admission.lock().map_err(|_| poisoned())?;
        let access = self.access.write().map_err(|_| poisoned())?;
        drop(admission);
        Ok(access)
    }
}

pub(crate) fn for_document(path: &Path) -> io::Result<Arc<ReadGate>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Weak<ReadGate>>>> = OnceLock::new();
    let mut gates = GATES.get_or_init(Default::default).lock().map_err(|_| poisoned())?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(path).and_then(Weak::upgrade) {
        return Ok(gate);
    }
    let gate = Arc::new(ReadGate::default());
    gates.insert(path.to_owned(), Arc::downgrade(&gate));
    Ok(gate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Barrier, mpsc},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn overlapping_reads_issue_one_request_and_later_reads_fetch_again() {
        const READERS: usize = 20;
        let gate = Arc::new(ReadGate::default());
        let start = Arc::new(Barrier::new(READERS + 1));
        let release = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..READERS).map(|_| {
            let (gate, start, release, calls) = (gate.clone(), start.clone(), release.clone(), calls.clone());
            thread::spawn(move || {
                start.wait();
                gate.read(|| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    while !release.load(Ordering::SeqCst) { thread::yield_now(); }
                    Ok(vec![1])
                }).unwrap()
            })
        }).collect();
        start.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        while calls.load(Ordering::SeqCst) <= 1
            && gate.pending.lock().unwrap().as_ref().map(Arc::strong_count) != Some(READERS + 1)
            && Instant::now() < deadline {
            thread::yield_now();
        }
        release.store(true, Ordering::SeqCst);
        for worker in workers { assert_eq!(worker.join().unwrap(), vec![1]); }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(gate.read(|| Ok(vec![2])).unwrap(), vec![2]);
    }

    #[test]
    fn writes_wait_for_readers_and_later_reads_observe_the_write() {
        let gate = Arc::new(ReadGate::default());
        let value = Arc::new(AtomicUsize::new(1));
        let (started, began) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let read_gate = gate.clone();
        let read_value = value.clone();
        let reader = thread::spawn(move || read_gate.read(|| {
            started.send(()).unwrap();
            released.recv().unwrap();
            Ok(vec![read_value.load(Ordering::SeqCst) as u8])
        }).unwrap());
        began.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(gate.access.try_write().is_err());
        release.send(()).unwrap();
        assert_eq!(reader.join().unwrap(), vec![1]);
        {
            let _write = gate.write().unwrap();
            value.store(2, Ordering::SeqCst);
            assert!(gate.access.try_read().is_err());
        }
        assert_eq!(gate.read(|| Ok(vec![value.load(Ordering::SeqCst) as u8])).unwrap(), vec![2]);
    }

    #[test]
    fn a_waiting_writer_runs_before_new_readers() {
        let gate = Arc::new(ReadGate::default());
        let value = Arc::new(AtomicUsize::new(1));
        let (started, began) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let first_gate = gate.clone();
        let first = thread::spawn(move || first_gate.read(|| {
            started.send(()).unwrap();
            released.recv().unwrap();
            Ok(vec![1])
        }).unwrap());
        began.recv_timeout(Duration::from_secs(5)).unwrap();
        let writer_gate = gate.clone();
        let writer_value = value.clone();
        let writer = thread::spawn(move || {
            let _write = writer_gate.write().unwrap();
            writer_value.store(2, Ordering::SeqCst);
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while gate.admission.try_lock().is_ok() {
            assert!(Instant::now() < deadline, "writer should wait at the admission gate");
            thread::yield_now();
        }
        let next_gate = gate.clone();
        let next_value = value.clone();
        let next = thread::spawn(move || next_gate.read(|| Ok(vec![next_value.load(Ordering::SeqCst) as u8])).unwrap());
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), vec![1]);
        writer.join().unwrap();
        assert_eq!(next.join().unwrap(), vec![2]);
    }

    #[test]
    fn failed_reads_can_be_retried() {
        let gate = ReadGate::default();
        assert_eq!(gate.read(|| Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(gate.read(|| Ok(vec![3])).unwrap(), vec![3]);
    }

    #[test]
    fn a_panicking_reader_releases_its_waiters_and_the_next_read() {
        let gate = Arc::new(ReadGate::default());
        let (started, began) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let first_gate = gate.clone();
        let first = thread::spawn(move || first_gate.read(|| {
            started.send(()).unwrap();
            released.recv().unwrap();
            panic!("reader failed");
        }));
        began.recv_timeout(Duration::from_secs(5)).unwrap();
        let second_gate = gate.clone();
        let second = thread::spawn(move || second_gate.read(|| Ok(vec![9])));
        let deadline = Instant::now() + Duration::from_secs(5);
        while gate.pending.lock().unwrap().as_ref().map(Arc::strong_count) != Some(3) {
            assert!(Instant::now() < deadline, "the second reader should join the pending request");
            thread::yield_now();
        }
        release.send(()).unwrap();
        assert!(first.join().is_err());
        assert_eq!(second.join().unwrap().unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(gate.read(|| Ok(vec![4])).unwrap(), vec![4]);
    }

    #[test]
    fn document_gates_are_shared_only_for_the_same_path() {
        let a = for_document(Path::new("/scope/a")).unwrap();
        assert!(Arc::ptr_eq(&a, &for_document(Path::new("/scope/a")).unwrap()));
        assert!(!Arc::ptr_eq(&a, &for_document(Path::new("/scope/b")).unwrap()));
    }
}
