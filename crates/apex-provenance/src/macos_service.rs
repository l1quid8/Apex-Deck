//! Startup migration for Macs whose old updater still loads a Background job.
//! These entry points use fixed system paths, never RPC or environment input.
use std::{
    ffi::OsString,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime},
};

struct Service {
    domain: String,
    label: String,
    plist: PathBuf,
    broker: PathBuf,
    repair_label: String,
    repair_command: Vec<OsString>,
    error_log: PathBuf,
}

impl Service {
    fn system() -> Self {
        let broker = Path::new(apex_provenance::ROOT).join("apex-provenance");
        Self {
            domain: "system".into(),
            label: "dev.apexdeck.provenance".into(),
            plist: "/Library/LaunchDaemons/dev.apexdeck.provenance.plist".into(),
            repair_label: "dev.apexdeck.provenance-scheduling-repair".into(),
            repair_command: vec![
                Path::new(apex_provenance::ROOT)
                    .join("repair-broker")
                    .into_os_string(),
                "repair-macos-service".into(),
            ],
            error_log: "/var/log/apex-provenance.log".into(),
            broker,
        }
    }
    fn target(&self) -> String {
        format!("{}/{}", self.domain, self.label)
    }
    fn repair_target(&self) -> String {
        format!("{}/{}", self.domain, self.repair_label)
    }
    fn repair_binary(&self) -> PathBuf {
        self.broker.with_file_name("repair-broker")
    }
    fn repair_plist(&self) -> PathBuf {
        self.broker.with_file_name("scheduling-repair.plist")
    }
}

fn repaired_plist(bytes: &[u8], service: &Service) -> Result<Option<Vec<u8>>, String> {
    let mut value =
        plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let dict = value
        .as_dictionary_mut()
        .ok_or("Invalid broker service plist")?;
    let args = dict
        .get("ProgramArguments")
        .and_then(plist::Value::as_array);
    if dict.get("Label").and_then(plist::Value::as_string) != Some(service.label.as_str())
        || !args
            .is_some_and(|args| args.len() == 1 && args[0].as_string() == service.broker.to_str())
    {
        return Err("Unexpected broker service configuration".into());
    }
    if dict.get("ProcessType").and_then(plist::Value::as_string) == Some("Interactive") {
        return Ok(None);
    }
    dict.insert("ProcessType".into(), "Interactive".into());
    let mut repaired = Vec::new();
    value
        .to_writer_xml(&mut repaired)
        .map_err(|e| e.to_string())?;
    Ok(Some(repaired))
}

fn launchctl(args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    let mut child = Command::new("/bin/launchctl")
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Drain both pipes while waiting: a preserved large environment can make
    // `print` exceed the pipe buffer even with a plist under the input limit.
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => (),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.to_string());
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break Err("Broker scheduling repair: launchctl timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout
        .join()
        .map_err(|_| "Could not read launchctl stdout")?;
    let stderr = stderr
        .join()
        .map_err(|_| "Could not read launchctl stderr")?;
    Ok(std::process::Output {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn drain(
    reader: impl std::io::Read + Send + 'static,
) -> std::thread::JoinHandle<Result<Vec<u8>, String>> {
    std::thread::spawn(move || {
        use std::io::Read;
        const LIMIT: usize = 1024 * 1024;
        let mut bytes = Vec::new();
        reader
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > LIMIT {
            return Err("Broker scheduling repair: launchctl output exceeds limit".into());
        }
        Ok(bytes)
    })
}

fn checked(args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let result = launchctl(args)?;
    if result.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Broker scheduling repair: launchctl failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ))
    }
}

fn interactive(state: &str) -> bool {
    state
        .lines()
        .filter_map(|line| line.trim().strip_prefix("spawn type = "))
        .any(|kind| kind.split_whitespace().next() == Some("interactive"))
}

fn queue_reload(service: &Service, bytes: &[u8]) -> Result<bool, String> {
    let repaired = repaired_plist(bytes, service)?;
    let state = launchctl(&["print".as_ref(), service.target().as_ref()])?;
    if !state.status.success() {
        return Err("Could not inspect broker scheduling".into());
    }
    if repaired.is_none() && interactive(&String::from_utf8_lossy(&state.stdout)) {
        return Ok(false);
    }

    // A fixed, independent launchd job must do the reload: bootout also kills
    // the broker's process group. Never run downloaded code or a shell here.
    // Old updater processes cannot acquire new Python functions mid-install,
    // but they already wait for a replacement broker's fresh readiness socket.
    let existing = launchctl(&["print".as_ref(), service.repair_target().as_ref()])?;
    if existing.status.success() {
        if String::from_utf8_lossy(&existing.stdout)
            .lines()
            .any(|line| line.trim() == "state = running")
        {
            return Ok(true);
        }
        checked(&["bootout".as_ref(), service.repair_target().as_ref()])?;
    }
    // Retain the exact executable inode even if the updater rolls back the
    // active path before launchd starts this helper. Old binaries ignore the
    // new repair argument, so executing the active path is unsafe here.
    match std::fs::remove_file(service.repair_binary()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => (),
    }
    std::fs::hard_link(&service.broker, service.repair_binary()).map_err(|e| e.to_string())?;
    let mut helper = plist::Dictionary::new();
    helper.insert("Label".into(), service.repair_label.clone().into());
    helper.insert(
        "ProgramArguments".into(),
        plist::Value::Array(
            service
                .repair_command
                .iter()
                .map(|arg| arg.to_str().map(|s| s.into()).ok_or("Invalid helper path"))
                .collect::<Result<_, _>>()?,
        ),
    );
    helper.insert("RunAtLoad".into(), true.into());
    helper.insert("ProcessType".into(), "Interactive".into());
    helper.insert(
        "StandardErrorPath".into(),
        service
            .error_log
            .to_str()
            .ok_or("Invalid helper log path")?
            .into(),
    );
    // No KeepAlive: a failed migration must never retry over a rolled-back
    // installation. launchctl submit implicitly adds KeepAlive, so use a plist.
    let mut document = Vec::new();
    plist::Value::Dictionary(helper)
        .to_writer_xml(&mut document)
        .map_err(|e| e.to_string())?;
    super::atomic(&service.repair_plist(), &document, 0o644)?;
    checked(&[
        "bootstrap".as_ref(),
        service.domain.as_ref(),
        service.repair_plist().as_os_str(),
    ])?;
    Ok(true)
}

fn current(service: &Service) -> bool {
    let Ok(active) = std::fs::symlink_metadata(&service.broker) else {
        return false;
    };
    let Ok(saved) = std::fs::symlink_metadata(service.repair_binary()) else {
        return false;
    };
    let age = std::fs::metadata(service.repair_plist())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|created| SystemTime::now().duration_since(created).ok());
    active.is_file()
        && saved.is_file()
        && active.dev() == saved.dev()
        && active.ino() == saved.ino()
        && age.is_some_and(|age| age < Duration::from_secs(10))
}

fn cleanup(service: &Service) {
    let _ = std::fs::remove_file(service.repair_plist());
    let _ = std::fs::remove_file(service.repair_binary());
    let _ = launchctl(&["bootout".as_ref(), service.repair_target().as_ref()]);
}

fn reload(service: &Service, bytes: &[u8]) -> Result<(), String> {
    let repaired = repaired_plist(bytes, service)?;
    if !current(service) {
        cleanup(service);
        return Ok(());
    }
    if let Some(bytes) = repaired {
        super::atomic(&service.plist, &bytes, 0o644)?;
    }
    if !current(service) {
        cleanup(service);
        return Ok(());
    }
    checked(&["bootout".as_ref(), service.target().as_ref()])?;
    retry_bootstrap(service, || {
        checked(&[
            "bootstrap".as_ref(),
            service.domain.as_ref(),
            service.plist.as_os_str(),
        ])
    })?;
    cleanup(service);
    Ok(())
}

fn retry_bootstrap(
    service: &Service,
    mut start: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    for attempt in 0..3 {
        if !current(service) {
            return Ok(());
        }
        match start() {
            Ok(()) => return Ok(()),
            Err(error) if attempt == 2 => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    unreachable!()
}

pub fn startup() -> Result<bool, String> {
    let service = Service::system();
    protect_root(&service)?;
    let bytes = apex_provenance::io::root_file_limit(&service.plist, 64 * 1024)?;
    queue_reload(&service, &bytes)
}

pub fn repair() -> Result<(), String> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("Broker service repair requires root".into());
    }
    let service = Service::system();
    protect_root(&service)?;
    let bytes = apex_provenance::io::root_file_limit(&service.plist, 64 * 1024)?;
    reload(&service, &bytes)
}

fn protect_root(service: &Service) -> Result<(), String> {
    // Also validate the authority directory used for helper staging, without
    // opening keys/journal or changing any pins. No user-owned staging paths.
    apex_provenance::io::root_file(&service.broker.with_file_name("config.json"))?;
    let meta = std::fs::symlink_metadata(&service.broker).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err("Unprotected broker executable".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };

    fn service(base: &Path) -> Service {
        let label = format!(
            "dev.apexdeck.scheduling-test-{}",
            base.file_name().unwrap().to_string_lossy()
        );
        Service {
            domain: format!("gui/{}", unsafe { libc::geteuid() }),
            repair_label: format!("{label}-repair"),
            label,
            plist: base.join("broker.plist"),
            broker: base.join("broker"),
            repair_command: vec![base.join("repair").into_os_string()],
            error_log: base.join("err"),
        }
    }

    fn document(service: &Service) -> plist::Value {
        let mut dict = plist::Dictionary::new();
        dict.insert("Label".into(), service.label.clone().into());
        dict.insert(
            "ProgramArguments".into(),
            plist::Value::Array(vec![service.broker.to_str().unwrap().into()]),
        );
        dict.insert("ProcessType".into(), "Background".into());
        dict.insert("RunAtLoad".into(), true.into());
        dict.insert("ExampleSetting".into(), "preserved".into());
        plist::Value::Dictionary(dict)
    }

    #[test]
    fn repairs_xml_and_binary_without_dropping_other_settings() {
        let service = service(Path::new("/tmp/plist-fixture"));
        let original = document(&service);
        for binary in [false, true] {
            let mut bytes = Vec::new();
            if binary {
                original.to_writer_binary(&mut bytes).unwrap();
            } else {
                original.to_writer_xml(&mut bytes).unwrap();
            }
            let repaired = repaired_plist(&bytes, &service)
                .unwrap()
                .expect("Background must be repaired");
            let got = plist::Value::from_reader(std::io::Cursor::new(&repaired)).unwrap();
            let mut expected = original.clone();
            expected
                .as_dictionary_mut()
                .unwrap()
                .insert("ProcessType".into(), "Interactive".into());
            assert_eq!(got, expected);
            assert!(repaired_plist(&repaired, &service).unwrap().is_none());
        }
    }

    #[test]
    fn refuses_malformed_or_unexpected_service_before_launching_anything() {
        let service = service(Path::new("/tmp/plist-fixture"));
        assert!(repaired_plist(b"not a plist", &service).is_err());
        for field in ["Label", "ProgramArguments"] {
            let mut doc = document(&service);
            doc.as_dictionary_mut()
                .unwrap()
                .insert(field.into(), "other-service".into());
            let mut bytes = Vec::new();
            doc.to_writer_xml(&mut bytes).unwrap();
            assert!(queue_reload(&service, &bytes).is_err());
        }
    }

    // Only the test binary reads this environment variable. Production has no
    // path/domain override. These two ignored tests are child launchd programs.
    #[test]
    #[ignore]
    fn launchd_broker_child() {
        let base = PathBuf::from(std::env::var_os("APEX_SCHEDULING_TEST_DIR").unwrap());
        let service = service(&base);
        if !queue_reload(&service, &std::fs::read(&service.plist).unwrap()).unwrap() {
            let _listener =
                std::os::unix::net::UnixListener::bind(base.join("broker.sock")).unwrap();
            let result = Command::new("/bin/ps")
                .args(["-p", &std::process::id().to_string(), "-o", "pri="])
                .output()
                .unwrap();
            std::fs::write(base.join("ready"), result.stdout).unwrap();
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    #[test]
    #[ignore]
    fn launchd_repair_child() {
        let base = PathBuf::from(std::env::var_os("APEX_SCHEDULING_TEST_DIR").unwrap());
        let service = service(&base);
        reload(&service, &std::fs::read(&service.plist).unwrap()).unwrap();
    }

    struct Fixture {
        base: PathBuf,
        service: Service,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for target in [self.service.target(), self.service.repair_target()] {
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &target])
                    .output();
            }
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn failed_helper_is_one_shot_instead_of_scheduled_for_respawn() {
        let base =
            Path::new("/tmp").join(format!("apex-scheduling-failure-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let mut fixture = Fixture {
            service: service(&base),
            base,
        };
        fixture.service.repair_command = vec!["/usr/bin/false".into()];
        let service = &fixture.service;
        std::fs::write(&service.broker, "unused fixture broker").unwrap();
        let mut doc = document(service);
        doc.as_dictionary_mut()
            .unwrap()
            .insert("RunAtLoad".into(), false.into());
        doc.to_file_xml(&service.plist).unwrap();
        checked(&[
            "bootstrap".as_ref(),
            service.domain.as_ref(),
            service.plist.as_os_str(),
        ])
        .unwrap();
        assert!(queue_reload(service, &std::fs::read(&service.plist).unwrap()).unwrap());
        let deadline = Instant::now() + Duration::from_secs(2);
        let state = loop {
            let result = launchctl(&["print".as_ref(), service.repair_target().as_ref()]).unwrap();
            let state = String::from_utf8_lossy(&result.stdout).into_owned();
            if state.contains("last exit code = 1") || Instant::now() > deadline {
                break state;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(state.contains("last exit code = 1"), "{state}");
        assert!(
            !state.contains("keepalive") && !state.contains("spawn scheduled"),
            "{state}"
        );
    }

    #[test]
    fn delayed_helper_does_not_change_a_broker_replaced_by_rollback() {
        let base = Path::new("/tmp").join(format!("apex-scheduling-stale-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let fixture = Fixture {
            service: service(&base),
            base,
        };
        let service = &fixture.service;
        std::fs::write(&service.broker, "new broker").unwrap();
        std::fs::hard_link(&service.broker, fixture.base.join("repair-broker")).unwrap();
        document(service)
            .to_file_xml(service.repair_plist())
            .unwrap();
        assert!(
            current(service),
            "the prepared snapshot must be current before rollback"
        );
        std::fs::write(fixture.base.join("previous-broker"), "restored broker").unwrap();
        std::fs::rename(fixture.base.join("previous-broker"), &service.broker).unwrap();
        assert!(
            !current(service),
            "rollback must invalidate the snapshot even while it is fresh"
        );
        document(service).to_file_xml(&service.plist).unwrap();
        let before = std::fs::read(&service.plist).unwrap();
        reload(service, &before).unwrap();
        assert_eq!(std::fs::read(&service.plist).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(&service.broker).unwrap(),
            "restored broker"
        );
    }

    fn retry_fixture(name: &str) -> Fixture {
        let base = Path::new("/tmp").join(format!("apex-scheduling-{name}-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let fixture = Fixture {
            service: service(&base),
            base,
        };
        std::fs::write(&fixture.service.broker, "new broker").unwrap();
        std::fs::hard_link(&fixture.service.broker, fixture.service.repair_binary()).unwrap();
        document(&fixture.service)
            .to_file_xml(fixture.service.repair_plist())
            .unwrap();
        assert!(current(&fixture.service));
        fixture
    }

    #[test]
    fn large_service_print_is_drained_while_waiting_for_launchctl() {
        let fixture = retry_fixture("large-print");
        let service = &fixture.service;
        let mut doc = document(service);
        let dict = doc.as_dictionary_mut().unwrap();
        dict.insert("RunAtLoad".into(), false.into());
        let mut env = plist::Dictionary::new();
        env.insert("EXAMPLE".into(), "".into());
        dict.insert("EnvironmentVariables".into(), plist::Value::Dictionary(env));
        let mut baseline = Vec::new();
        doc.to_writer_xml(&mut baseline).unwrap();
        doc.as_dictionary_mut()
            .unwrap()
            .get_mut("EnvironmentVariables")
            .unwrap()
            .as_dictionary_mut()
            .unwrap()
            .insert("EXAMPLE".into(), "v".repeat(65_470 - baseline.len()).into());
        doc.to_file_xml(&service.plist).unwrap();
        assert!(std::fs::metadata(&service.plist).unwrap().len() < 64 * 1024);
        checked(&[
            "bootstrap".as_ref(),
            service.domain.as_ref(),
            service.plist.as_os_str(),
        ])
        .unwrap();
        let result = launchctl(&["print".as_ref(), service.target().as_ref()])
            .expect("valid large print must not hit the command timeout");
        assert!(result.status.success());
        assert!(
            result.stdout.len() > 65_536,
            "fixture must exceed the pipe buffer"
        );
    }

    #[test]
    fn transient_bootstrap_failure_retries_without_another_bootout() {
        let fixture = retry_fixture("retry");
        let service = &fixture.service;
        let mut doc = document(service);
        doc.as_dictionary_mut()
            .unwrap()
            .insert("RunAtLoad".into(), false.into());
        doc.to_file_xml(&service.plist).unwrap();
        let mut calls = 0;
        retry_bootstrap(service, || {
            calls += 1;
            if calls == 1 {
                return Err("injected transient launchd failure".into());
            }
            checked(&[
                "bootstrap".as_ref(),
                service.domain.as_ref(),
                service.plist.as_os_str(),
            ])
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert!(launchctl(&["print".as_ref(), service.target().as_ref()])
            .unwrap()
            .status
            .success());
        checked(&["bootout".as_ref(), service.target().as_ref()]).unwrap();
        calls = 0;
        assert!(retry_bootstrap(service, || {
            calls += 1;
            Err("persistent launchd failure".into())
        })
        .is_err());
        assert_eq!(calls, 3, "persistent failure must be bounded");
    }

    #[test]
    fn bootstrap_retry_stops_if_the_updater_has_rolled_back() {
        let fixture = retry_fixture("retry-stale");
        let service = &fixture.service;
        let mut calls = 0;
        retry_bootstrap(service, || {
            calls += 1;
            std::fs::write(fixture.base.join("old-broker"), "restored broker").unwrap();
            std::fs::rename(fixture.base.join("old-broker"), &service.broker).unwrap();
            Err("injected transient failure during rollback".into())
        })
        .unwrap();
        assert_eq!(
            calls, 1,
            "no bootstrap of a restored broker by the stale helper"
        );
    }

    #[test]
    fn helper_delayed_past_the_migration_window_does_not_change_the_service() {
        let fixture = retry_fixture("expired");
        let service = &fixture.service;
        document(service).to_file_xml(&service.plist).unwrap();
        let before = std::fs::read(&service.plist).unwrap();
        std::fs::File::options()
            .write(true)
            .open(service.repair_plist())
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(20)),
            )
            .unwrap();
        assert!(!current(service));
        reload(service, &before).unwrap();
        assert_eq!(std::fs::read(&service.plist).unwrap(), before);
    }

    #[test]
    fn legacy_updater_background_bootstrap_reloads_as_interactive_before_ready() {
        let base = Path::new("/tmp").join(format!("apex-scheduling-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let fixture = Fixture {
            service: service(&base),
            base,
        };
        let service = &fixture.service;
        // A launchd child has no access to protected user folders such as
        // Downloads. Run its disposable copy beside the fixture instead.
        let child_binary = fixture.base.join("test-binary");
        std::fs::copy(std::env::current_exe().unwrap(), &child_binary).unwrap();
        for (name, child) in [
            ("broker", "launchd_broker_child"),
            ("repair", "launchd_repair_child"),
        ] {
            let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            let script = format!("#!/bin/sh\nexport APEX_SCHEDULING_TEST_DIR={}\nexec {} --exact macos_service::tests::{} --ignored --nocapture\n",
                quote(fixture.base.to_str().unwrap()), quote(child_binary.to_str().unwrap()), child);
            let path = fixture.base.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut doc = document(service);
        let dict = doc.as_dictionary_mut().unwrap();
        dict.insert(
            "StandardOutPath".into(),
            fixture.base.join("out").to_str().unwrap().into(),
        );
        dict.insert(
            "StandardErrorPath".into(),
            fixture.base.join("err").to_str().unwrap().into(),
        );
        doc.to_file_xml(&service.plist).unwrap();
        // This is the old updater's operation, with no repair call and no new
        // updater code: the replacement broker has to close the gap itself.
        let result = Command::new("/bin/launchctl")
            .args(["bootstrap", &service.domain])
            .arg(&service.plist)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let deadline = Instant::now() + Duration::from_secs(12);
        while !fixture.base.join("ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let state = Command::new("/bin/launchctl")
            .args(["print", &service.target()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        let errors = std::fs::read_to_string(fixture.base.join("err")).unwrap_or_default();
        assert!(
            state.contains("spawn type = interactive"),
            "{state}\n{errors}"
        );
        let priority: u32 = std::fs::read_to_string(fixture.base.join("ready"))
            .expect("ready only after repaired restart")
            .trim()
            .parse()
            .unwrap();
        assert!(priority > 4, "still at Background priority: {priority}");
        std::os::unix::net::UnixStream::connect(fixture.base.join("broker.sock"))
            .expect("replacement readiness socket");
        let before = std::fs::read(&service.plist).unwrap();
        assert!(
            !queue_reload(service, &before).unwrap(),
            "Interactive startup must not queue another reload"
        );
        assert_eq!(std::fs::read(&service.plist).unwrap(), before);
        let installed = plist::Value::from_file(&service.plist).unwrap();
        assert_eq!(
            installed
                .as_dictionary()
                .unwrap()
                .get("ProcessType")
                .unwrap()
                .as_string(),
            Some("Interactive")
        );
        assert_eq!(
            installed
                .as_dictionary()
                .unwrap()
                .get("ExampleSetting")
                .unwrap()
                .as_string(),
            Some("preserved")
        );
        println!("old-updater bootstrap: Interactive restart at priority {priority}, fresh readiness socket, other plist settings preserved");
    }
}
