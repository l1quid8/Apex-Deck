//! LocalSystem Windows broker. No shell execution or general filesystem RPC.
use apex_provenance::{windows as win, *};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{OsStr, OsString},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::Semaphore,
};
use windows_service::{
    define_windows_service,
    service::*,
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};
use windows_sys::Win32::{
    Security::SECURITY_ATTRIBUTES, System::Pipes::GetNamedPipeClientProcessId,
};
const NAME: &str = "ApexDeckProvenance";
// Requests run side by side so one slow client cannot hold up the rest. The cap
// bounds what a flood of connections can cost.
const MAX_CLIENTS: usize = 64;
// 0x12019b is read/write access without FILE_CREATE_PIPE_INSTANCE, which GW would
// grant: clients can connect, but only SYSTEM can add a server end to this name.
const PIPE_SDDL: &str = "O:SYG:SYD:P(A;;GA;;;SY)(A;;0x12019b;;;AU)";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    path: PathBuf,
    sha256: String,
}
impl Pin {
    fn new(path: PathBuf) -> Result<Self, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let sha256 = win::digest(&path)?;
        Ok(Self { path, sha256 })
    }
    fn matches(&self, path: &Path) -> bool {
        path.canonicalize().is_ok_and(|path| path == self.path)
            && win::digest(path).is_ok_and(|hash| hash == self.sha256)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    ui: Pin,
    daemon: Pin,
    helper: Pin,
    asar: Pin,
}
struct State {
    key: Ed25519KeyPair,
    journal: Journal,
    path: PathBuf,
}
impl State {
    fn open(sid: &str) -> Result<Self, String> {
        let user = win::user_root(sid)?;
        win::secure_directory(&user, false)?;
        let private = win::root()?.join("secrets").join(sid);
        win::secure_directory(&private, true)?;
        let key_path = private.join("private-key");
        let public = user.join("public-key");
        let path = private.join("journal.json");
        if !key_path.exists() {
            if public.exists() || path.exists() {
                return Err("Missing established signing key; refusing authority reset".into());
            }
            let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| "Cannot create authority key")?;
            win::atomic(&key_path, key.as_ref())?;
        }
        win::private_handle(&win::open_protected(&key_path)?)?;
        let key = Ed25519KeyPair::from_pkcs8(&win::root_file(&key_path, 4096)?)
            .map_err(|_| "Invalid authority key")?;
        if public.exists() {
            if win::root_file(&public, 32)? != key.public_key().as_ref() {
                return Err("Authority key mismatch".into());
            }
        } else {
            win::atomic(&public, key.public_key().as_ref())?;
        }
        let journal = if path.exists() {
            Journal::open(
                &win::root_file(&path, JOURNAL_BYTES)?,
                key.public_key().as_ref(),
            )?
        } else {
            Journal::new()
        };
        Ok(Self { key, journal, path })
    }
    fn apply(
        &mut self,
        request: &Value,
        ui: bool,
        daemon: bool,
        sid: &str,
    ) -> Result<Value, String> {
        if request["op"] == "identity" {
            return Ok(json!({"ready":true}));
        }
        let folder = request["dataDir"]
            .as_str()
            .ok_or("Missing data directory")?;
        // Pinned clients canonicalize under their own user token. The SYSTEM broker
        // never opens arbitrary caller-selected data paths or executes their contents.
        if folder.len() > 4096
            || folder.contains('\0')
            || folder.contains('\\')
            || !Path::new(folder).is_absolute()
            || folder.split('/').any(|part| part == "." || part == "..")
        {
            return Err("Invalid canonical Windows scope".into());
        }
        if request["op"] == "host_lock" {
            if !daemon {
                return Err("Host locks require the pinned daemon".into());
            }
            let nonce = request["nonce"]
                .as_str()
                .filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or("Invalid host ownership challenge")?;
            let directory = win::host_locks(sid)?;
            win::user_directory(&directory, sid)?;
            let binding = serde_json::to_vec(&(0u32, folder)).map_err(|e| e.to_string())?;
            use sha2::{Digest, Sha256};
            let path = directory.join(format!("{:x}", Sha256::digest(binding)));
            if path.exists() {
                if !win::root_file(&path, 0)?.is_empty() {
                    return Err("Invalid host lock".into());
                }
            } else {
                if std::fs::read_dir(&directory)
                    .map_err(|e| e.to_string())?
                    .count()
                    >= 4096
                {
                    return Err("Host lock capacity reached".into());
                }
                win::atomic(&path, b"")?;
            }
            return serde_json::to_value(sign(
                &self.key,
                &json!({"domain":DOMAIN,"kind":"hostLock","uid":0,"dataDir":folder,"nonce":nonce}),
            )?)
            .map_err(|e| e.to_string());
        }
        let (next, signed) =
            broker::transaction(&self.journal, &self.key, folder, request, ui, daemon)?;
        if request["op"] != "read" {
            win::atomic(
                &self.path,
                &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
            )?;
            self.journal = next;
        }
        serde_json::to_value(signed).map_err(|e| e.to_string())
    }
}
fn pipe(first: bool) -> Result<NamedPipeServer, String> {
    let descriptor = win::descriptor(PIPE_SDDL)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                win::PIPE,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
    .map_err(|e| e.to_string())
}
async fn serve(
    stop: Arc<AtomicBool>,
    running: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if win::current_sid()? != win::SYSTEM {
        return Err("Authority must run as LocalSystem".into());
    }
    let config: Config =
        serde_json::from_slice(&win::root_file(&win::root()?.join("config.json"), 65536)?)
            .map_err(|e| e.to_string())?;
    for pin in [&config.ui, &config.daemon, &config.helper, &config.asar] {
        if !pin.matches(&pin.path) {
            return Err("Installed authority build does not match protected pins".into());
        }
    }
    let config = Arc::new(config);
    let clients = Arc::new(Semaphore::new(MAX_CLIENTS));
    let mut listener = pipe(true)?;
    running()?;
    while !stop.load(Ordering::Relaxed) {
        let Ok(permit) =
            tokio::time::timeout(Duration::from_millis(200), clients.clone().acquire_owned()).await
        else {
            continue;
        };
        let permit = permit.map_err(|e| e.to_string())?;
        match tokio::time::timeout(Duration::from_millis(200), listener.connect()).await {
            Err(_) => continue,
            Ok(Ok(())) => (),
            // A client can vanish before it is accepted. That costs one instance,
            // never the service.
            Ok(Err(_)) => {
                match pipe(false) {
                    Ok(fresh) => listener = fresh,
                    Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
                }
                continue;
            }
        }
        // Keep a fresh listening instance alive before retiring the used one.
        // The client also checks this instance's PID against SCM (owner alone
        // cannot identify a server when Windows shares an object's descriptor).
        let Ok(fresh) = pipe(false) else {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        let mut stream = std::mem::replace(&mut listener, fresh);
        let config = config.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let response =
                tokio::time::timeout(Duration::from_secs(10), answer(&mut stream, &config))
                    .await
                    .unwrap_or_else(|_| Err("Authority client timed out".into()));
            let wait = Duration::from_millis(if response.is_ok() { 2000 } else { 500 });
            let response = response.unwrap_or_else(|error: String| json!({"error":error}));
            if let Ok(mut bytes) = serde_json::to_vec(&response) {
                bytes.push(b'\n');
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), stream.write_all(&bytes)).await;
                // Keep the server handle alive until the client consumes its frame.
                // Disconnecting early can discard unread named-pipe output.
                let mut acknowledgement = [0u8; 1];
                let _ = tokio::time::timeout(wait, stream.read(&mut acknowledgement)).await;
            }
            // Retire the used wrapper; Mio retains its completed EOF state.
            drop(stream);
        });
    }
    Ok(())
}
async fn answer(stream: &mut NamedPipeServer, config: &Config) -> Result<Value, String> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle(), &mut pid) } == 0 {
        return Err("No kernel pipe peer".into());
    }
    let process = win::process(pid)?;
    let sid = win::process_sid(process.as_raw_handle())?;
    let image = win::process_image(process.as_raw_handle())?;
    let ui = config.ui.matches(&image);
    let daemon = config.daemon.matches(&image);
    let helper = config.helper.matches(&image);
    if !ui && !daemon && !helper {
        return Err("Untrusted provenance peer".into());
    }
    if ui || daemon {
        win::peer_intact(pid)?;
    }
    let mut bytes = Vec::new();
    BufReader::new((&mut *stream).take(MAX_BYTES as u64 + 1))
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES || bytes.last() != Some(&b'\n') {
        return Err("Invalid authority request frame".into());
    }
    if win::pipe_client_sid(stream.as_raw_handle())? != sid {
        return Err("Pipe and process identities do not match".into());
    }
    let mut request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if helper && request["op"] != "identity" {
        return Err("Helper cannot issue or consume authority".into());
    }
    if request["op"] == "hello" && ui {
        let nonce = request["nonce"]
            .as_str()
            .filter(|value| value.len() == 36)
            .ok_or("Invalid UI challenge")?;
        let hello = sign(
            &State::open(&sid)?.key,
            &json!({"domain":DOMAIN,"kind":"hello","nonce":nonce}),
        )?;
        let mut bytes = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        BufReader::new((&mut *stream).take(MAX_BYTES as u64 + 1))
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES || bytes.last() != Some(&b'\n') {
            return Err("Invalid UI submission frame".into());
        }
        if win::pipe_client_sid(stream.as_raw_handle())? != sid {
            return Err("UI pipe identity changed".into());
        }
        request = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    } else if ui {
        return Err("UI submission requires authority authentication".into());
    }
    // Open each transaction from durable state, with no await before it commits.
    // The service runs on one thread, so requests that wait on their clients side
    // by side still reach the journal one at a time and lose no claims.
    State::open(&sid)?.apply(&request, ui, daemon, &sid)
}
define_windows_service!(ffi_main, service_main);
fn service_main(_args: Vec<OsString>) {
    let stop = Arc::new(AtomicBool::new(false));
    let control = stop.clone();
    let Ok(status) = service_control_handler::register(NAME, move |event| match event {
        ServiceControl::Stop => {
            control.store(true, Ordering::Relaxed);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    }) else {
        return;
    };
    let report = |state, exit| {
        status
            .set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: if state == ServiceState::Running {
                    ServiceControlAccept::STOP
                } else {
                    ServiceControlAccept::empty()
                },
                exit_code: ServiceExitCode::Win32(exit),
                checkpoint: 0,
                wait_hint: Duration::from_secs(10),
                process_id: None,
            })
            .map_err(|e| e.to_string())
    };
    let _ = report(ServiceState::StartPending, 0);
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
        .and_then(|runtime| runtime.block_on(serve(stop, || report(ServiceState::Running, 0))));
    if let Err(error) = &result {
        if let Ok(root) = win::root() {
            let _ = win::atomic(&root.join("service-error.txt"), error.as_bytes());
        }
    }
    let _ = report(ServiceState::Stopped, if result.is_ok() { 0 } else { 1 });
}
fn manager() -> Result<ServiceManager, String> {
    ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| e.to_string())
}
fn stop_service(service: &Service) -> Result<(), String> {
    if service
        .query_status()
        .map_err(|e| e.to_string())?
        .current_state
        != ServiceState::Stopped
    {
        service.stop().map_err(|e| e.to_string())?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while service
        .query_status()
        .map_err(|e| e.to_string())?
        .current_state
        != ServiceState::Stopped
    {
        if Instant::now() > deadline {
            return Err("Authority did not stop".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
fn install() -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let bin = executable.parent().ok_or("Missing bin folder")?;
    let resources = bin.parent().ok_or("Missing resources")?;
    let app = resources.parent().ok_or("Missing install folder")?;
    let program_files = win::program_files()?;
    if app != program_files.join("Apex Deck") {
        return Err(
            "The protected Windows build must be installed in Program Files/Apex Deck".into(),
        );
    }
    win::protected_ancestry(app)?;
    let config = Config {
        ui: Pin::new(app.join("Apex Deck.exe"))?,
        daemon: Pin::new(bin.join("apex-daemon.exe"))?,
        helper: Pin::new(executable.clone())?,
        asar: Pin::new(resources.join("app.asar"))?,
    };
    // Also reject user-writable install directories: pinning a file in AppData is
    // not a trusted installation, even if its current contents happen to match.
    for folder in [app, resources, bin] {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS
                    | windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            )
            .open(folder)
            .map_err(|e| e.to_string())?;
        win::protected_handle(&file)?;
    }
    let manager = manager()?;
    let info = ServiceInfo {
        name: NAME.into(),
        display_name: "Apex Deck Protected Authority".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: executable,
        launch_arguments: vec!["service".into()],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let service = match manager.open_service(NAME, ServiceAccess::ALL_ACCESS) {
        Ok(service) => {
            stop_service(&service)?;
            service.change_config(&info).map_err(|e| e.to_string())?;
            service
        }
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => manager
            .create_service(&info, ServiceAccess::ALL_ACCESS)
            .map_err(|e| e.to_string())?,
        Err(error) => return Err(error.to_string()),
    };
    // A service that stops on an error comes back by itself once the cause clears,
    // such as another program briefly holding the pipe name.
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86400)),
            reboot_msg: None,
            command: None,
            actions: Some(Vec::from([5, 5, 30].map(|seconds| ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(seconds),
            }))),
        })
        .map_err(|e| e.to_string())?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .map_err(|e| e.to_string())?;
    let root = win::root()?;
    win::secure_directory(&root, false)?;
    win::secure_directory(&root.join("users"), false)?;
    win::secure_directory(&root.join("secrets"), true)?;
    win::atomic(
        &root.join("config.json"),
        &serde_json::to_vec(&config).map_err(|e| e.to_string())?,
    )?;
    service.start(&[] as &[&OsStr]).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = service
            .query_status()
            .map_err(|e| e.to_string())?
            .current_state;
        if state == ServiceState::Running {
            break;
        }
        if state == ServiceState::Stopped || Instant::now() > deadline {
            return Err("Installed authority failed to start; inspect ProgramData/Apex Deck Provenance/service-error.txt".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
use std::os::windows::fs::OpenOptionsExt;
pub fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|s| s.to_str()) {
        Some("identity") if args.len() == 2 => {
            println!("{}", win::identity(Path::new(&args[1]))?);
            Ok(())
        }
        Some("protect-process") if args.len() == 2 => {
            let pid = args[1].to_str().and_then(|pid| pid.parse().ok());
            win::protect_process(pid.ok_or("Invalid process id")?)
        }
        Some("install") if args.len() == 1 => install(),
        Some("service") if args.len() == 1 => {
            service_dispatcher::start(NAME, ffi_main).map_err(|e| e.to_string())
        }
        Some("stop" | "uninstall") if args.len() == 1 => {
            let manager = manager()?;
            match manager.open_service(NAME, ServiceAccess::ALL_ACCESS) {
                Ok(service) => {
                    stop_service(&service)?;
                    if args[0] == "uninstall" {
                        service.delete().map_err(|e| e.to_string())?;
                    }
                    Ok(())
                }
                Err(windows_service::Error::Winapi(error))
                    if error.raw_os_error() == Some(1060) =>
                {
                    Ok(())
                }
                Err(error) => Err(error.to_string()),
            }
        }
        _ => Err("Expected install, stop, uninstall, service, or identity <data directory>".into()),
    }
}
