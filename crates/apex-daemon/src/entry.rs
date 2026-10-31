//! The command line shared by the `apex-daemon` binary and (in test builds only)
//! the `apex-daemon-fixture` binary.
use crate::cli::{self, Action};
use crate::{devices_cli, gateway_cli, pair_cli, promote_cli, serve, stdio};

pub fn run() {
    // Codex runs this executable before each MCP call; see the adapters'
    // codex_hook.rs. It answers and exits.
    if std::env::args().nth(1).as_deref() == Some(apex_adapters::CODEX_HOOK_ARG) {
        std::process::exit(apex_adapters::codex_hook_main());
    }
    // Claude and Codex bots run `apex-daemon phone <verb>` to use the shared phone.
    if std::env::args().nth(1).as_deref() == Some("phone") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(crate::phone_cli::main(&args));
    }
    crate::log_time::start();
    #[cfg(windows)]
    if let Err(error) = apex_provenance::windows::protect_process(std::process::id()) {
        eprintln!("apex-daemon: process protection unavailable: {error}");
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match cli::parse(&args) {
        Ok(cli) => cli,
        Err(why) => {
            eprintln!("apex-daemon: {why}");
            crate::log_time::flush();
            std::process::exit(2);
        }
    };
    match cli.action {
        Action::Help => println!("{}", cli::USAGE),
        Action::PairHelp => println!("{}", pair_cli::USAGE),
        Action::Version => println!("{}", crate::build_info::version_line()),
        Action::DataDir => exit(crate::paths::host_paths(cli.data_dir).map(|paths| println!("{}", paths.data.display()))),
        Action::Endpoint => exit(crate::paths::host_paths(cli.data_dir).and_then(|paths| {
            crate::ipc::endpoint(&paths.data)
                .map(|address| println!("{}", address.display()))
                .map_err(|error| format!("could not resolve the local endpoint: {error}"))
        })),
        Action::Stdio { attach } => exit(stdio::run(cli.data_dir, attach)),
        Action::Serve(options) => exit(serve::run(cli.data_dir, options)),
        Action::Devices(action) => exit(devices_cli::run(cli.data_dir, action)),
        Action::Keys(action) => exit(gateway_cli::run(cli.data_dir, action)),
        Action::AllowRoot(action) => exit(promote_cli::run(cli.data_dir, action)),
        Action::Pair(options) => exit(pair_cli::run(cli.data_dir, options)),
        Action::Remote(action) => exit(pair_cli::run_remote(cli.data_dir, action)),
    }
}

fn exit(result: Result<(), String>) -> ! {
    let code = match result {
        Ok(()) => 0,
        Err(why) => {
            eprintln!("apex-daemon: {why}");
            1
        }
    };
    // After the last message, so it is copied out before the process ends.
    crate::log_time::flush();
    std::process::exit(code);
}
