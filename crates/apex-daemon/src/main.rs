use apex_daemon::cli::{self, Action};

fn main() {
    // Codex runs this executable before each MCP call; see the adapters'
    // codex_hook.rs. It answers and exits.
    if std::env::args().nth(1).as_deref() == Some(apex_adapters::CODEX_HOOK_ARG) {
        std::process::exit(apex_adapters::codex_hook_main());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match cli::parse(&args) {
        Ok(cli) => cli,
        Err(why) => {
            eprintln!("apex-daemon: {why}");
            std::process::exit(2);
        }
    };
    match cli.action {
        Action::Help => println!("{}", cli::USAGE),
        Action::Version => println!("apex-daemon {}", env!("CARGO_PKG_VERSION")),
        Action::Serve(_) | Action::Stdio { .. } => {
            eprintln!("apex-daemon: not built yet");
            std::process::exit(1);
        }
    }
}
