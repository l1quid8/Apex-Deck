use std::path::PathBuf;
#[cfg(target_os = "macos")]
macro_rules! help_platform { () => { "Protected configuration and Work actions require the signed CLI authority installer.\n" } }
#[cfg(target_os = "linux")]
macro_rules! help_platform { () => { "On Linux, protected actions work once Deck's agent jail check passes (bubblewrap must be installed).\n/login signs in Deck's own provider login, used by agents below Full access.\n" } }
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
macro_rules! help_platform { () => { "Protected configuration and Work actions are not available on this platform yet.\n" } }
pub const HELP:&str=concat!("Apex standalone CLI\n\nUsage: apex [--data-dir <absolute-path>] [--thread <id>] [--connect-deck]\n       apex backend status|stop [--data-dir <absolute-path>]\n       apex --help | --version\n\nStarts or reuses the shared local backend automatically. Agents and threads are shared with Apex Deck.\n--connect-deck attaches only; --data-dir selects an isolated store. APEX_DECK_DATA_DIR is honored.\n/login attaches Codex or Claude · /agents create saves an agent\nEnter sends · Shift/Alt+Enter or Ctrl-J adds a line · Ctrl-C exits\n/ commands · @ agent completion · Esc stops current-thread work\nF1 Welcome · F2 approvals/questions · F3 Threads · F4 Agents\nPageUp/PageDown scroll history · Home/End move within composer\n\n", help_platform!());
pub struct Args {
    pub data: PathBuf,
    pub thread: Option<String>,
    pub connect_deck: bool,
}
pub enum Launch {
    Help,
    Version,
    Interactive(Args),
    Backend { args: Args, stop: bool },
}
/// `apex <version> (<commit>[-dirty])`. Printing the commit also puts it in the
/// binary, which is how the release packagers tell which commit built it.
pub fn version_line() -> String {
    let dirty = if apex_daemon::build_info::dirty() { "-dirty" } else { "" };
    format!("apex {} ({}{dirty})", env!("CARGO_PKG_VERSION"), apex_daemon::build_info::commit())
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Launch, String> {
    let mut args = args.into_iter();
    let mut data = None;
    let mut thread = None;
    let mut connect_deck = false;
    let mut backend = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connect-deck" => connect_deck = true,
            "backend" => backend = Some(match args.next().as_deref() {
                Some("status") => false,
                Some("stop") => true,
                _ => return Err("Usage: apex backend status|stop".into()),
            }),
            "--help" | "-h" => return Ok(Launch::Help),
            "--version" | "-V" => return Ok(Launch::Version),
            "--data-dir" => {
                let path =
                    PathBuf::from(args.next().ok_or("--data-dir requires an absolute path")?);
                if !path.is_absolute() {
                    return Err("--data-dir must be absolute".into());
                }
                data = Some(path);
            }
            "--thread" => {
                thread = Some(
                    args.next()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or("--thread requires an ID")?,
                )
            }
            _ => return Err(format!("Unknown option {arg}. Use --help.")),
        }
    }
    if data.is_none() {
        data = std::env::var("APEX_DECK_DATA_DIR").ok()
            .map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).map(PathBuf::from);
    }
    let data = apex_daemon::paths::host_paths(data)?.data;
    if !data.is_absolute() { return Err("Data directory must be absolute".into()); }
    let args = Args { data, thread, connect_deck };
    Ok(match backend { Some(stop) => Launch::Backend { args, stop }, None => Launch::Interactive(args) })
}
