//! The command line.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

pub const USAGE: &str = "\
usage: apex-daemon serve [--port N] [--bind ADDR] [--insecure-bind] [--exit-on-stdin-close] [--data-dir PATH]
       apex-daemon --stdio [--attach] [--data-dir PATH]
       apex-daemon data-dir [--data-dir PATH]
       apex-daemon devices list|add|tier|threads|revoke … [--data-dir PATH]

  serve            run the host and listen on a localhost WebSocket and a local socket
  --stdio          speak the protocol on stdin/stdout (for SSH); attaches to a running
                   daemon when there is one, otherwise runs the host until the connection closes
  --attach         with --stdio: fail instead of running the host in this process
  --port N         WebSocket port (default: one the system picks, written to daemon.json)
  --bind ADDR      WebSocket address (default 127.0.0.1)
  --insecure-bind  allow a non-localhost --bind before device pairing exists
  --exit-on-stdin-close
                   with serve: stop when stdin closes (the desktop app holds it open)
  data-dir         print the data folder the daemon would use, and exit
  devices          list, add, retier or revoke phones allowed to connect from outside;
                   `apex-daemon devices` alone explains each
  --data-dir PATH  where chats and settings live (default: the desktop app's folder)";

/// What the daemon was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Serve(ServeOptions),
    Stdio { attach: bool },
    /// Print the data folder.
    DataDir,
    Devices(crate::devices_cli::DevicesAction),
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeOptions {
    /// 0 lets the system pick.
    pub port: u16,
    pub bind: IpAddr,
    pub insecure_bind: bool,
    /// Stop when stdin reaches its end, as when the app that started the
    /// daemon quits or dies.
    pub exit_on_stdin_close: bool,
}

impl Default for ServeOptions {
    fn default() -> Self {
        ServeOptions { port: 0, bind: IpAddr::V4(Ipv4Addr::LOCALHOST), insecure_bind: false, exit_on_stdin_close: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub action: Action,
    pub data_dir: Option<PathBuf>,
}

/// Read the arguments after the program name.
pub fn parse(args: &[String]) -> Result<Cli, String> {
    // `devices …` takes words of its own; only --data-dir may come around them.
    let mut data_dir = None;
    let mut rest = Vec::new();
    let mut scan = args.iter();
    while let Some(arg) = scan.next() {
        if arg == "--data-dir" {
            data_dir = Some(PathBuf::from(scan.next().ok_or("--data-dir needs a value")?));
        } else {
            rest.push(arg.clone());
        }
    }
    if rest.first().map(String::as_str) == Some("devices") {
        return Ok(Cli { action: Action::Devices(crate::devices_cli::parse(&rest[1..])?), data_dir });
    }
    let mut serve = false;
    let mut stdio = false;
    let mut print_data_dir = false;
    let mut attach = false;
    let mut help = false;
    let mut version = false;
    let mut data_dir = None;
    let mut options = ServeOptions::default();
    let mut serve_flag = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "serve" => serve = true,
            "--stdio" => stdio = true,
            "data-dir" => print_data_dir = true,
            "--attach" => attach = true,
            "-h" | "--help" => help = true,
            "-V" | "--version" => version = true,
            "--data-dir" => data_dir = Some(PathBuf::from(value()?)),
            "--port" => {
                let port = value()?;
                options.port = port.parse().map_err(|_| format!("--port {port} is not a port number"))?;
                serve_flag.get_or_insert("--port");
            }
            "--bind" => {
                let bind = value()?;
                options.bind = bind.parse().map_err(|_| format!("--bind {bind} is not an IP address"))?;
                serve_flag.get_or_insert("--bind");
            }
            "--insecure-bind" => {
                options.insecure_bind = true;
                serve_flag.get_or_insert("--insecure-bind");
            }
            "--exit-on-stdin-close" => {
                options.exit_on_stdin_close = true;
                serve_flag.get_or_insert("--exit-on-stdin-close");
            }
            other => return Err(format!("unknown argument {other}\n\n{USAGE}")),
        }
    }
    let action = if help {
        Action::Help
    } else if version {
        Action::Version
    } else if usize::from(serve) + usize::from(stdio) + usize::from(print_data_dir) != 1 {
        return Err(format!("say serve or --stdio, or data-dir\n\n{USAGE}"));
    } else if print_data_dir {
        if attach {
            return Err("--attach goes with --stdio".into());
        }
        if let Some(flag) = serve_flag {
            return Err(format!("{flag} goes with serve"));
        }
        Action::DataDir
    } else if serve {
        if attach {
            return Err("--attach goes with --stdio".into());
        }
        Action::Serve(options)
    } else {
        if let Some(flag) = serve_flag {
            return Err(format!("{flag} goes with serve"));
        }
        Action::Stdio { attach }
    };
    Ok(Cli { action, data_dir })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, String> {
        super::parse(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn serve_listens_on_localhost_on_a_port_the_system_picks() {
        assert_eq!(parse(&["serve"]), Ok(Cli { action: Action::Serve(ServeOptions::default()), data_dir: None }));
        assert_eq!(ServeOptions::default().bind.to_string(), "127.0.0.1");
        assert_eq!(ServeOptions::default().port, 0);
    }

    #[test]
    fn serve_takes_a_port_an_address_and_the_insecure_switch() {
        let cli = parse(&["serve", "--port", "7000", "--bind", "0.0.0.0", "--insecure-bind"]).unwrap();
        assert_eq!(cli.action, Action::Serve(ServeOptions { port: 7000, bind: "0.0.0.0".parse().unwrap(), insecure_bind: true, exit_on_stdin_close: false }));
    }

    #[test]
    fn stdio_may_insist_on_attaching() {
        assert_eq!(parse(&["--stdio"]).unwrap().action, Action::Stdio { attach: false });
        assert_eq!(parse(&["--stdio", "--attach"]).unwrap().action, Action::Stdio { attach: true });
        assert_eq!(parse(&["--attach", "--stdio"]).unwrap().action, Action::Stdio { attach: true });
    }

    #[test]
    fn the_data_dir_goes_before_or_after_the_action() {
        assert_eq!(parse(&["--data-dir", "/d", "serve"]).unwrap().data_dir, Some(PathBuf::from("/d")));
        assert_eq!(parse(&["--stdio", "--data-dir", "/d"]).unwrap().data_dir, Some(PathBuf::from("/d")));
    }

    #[test]
    fn serve_may_exit_when_its_stdin_closes() {
        let cli = parse(&["serve", "--exit-on-stdin-close"]).unwrap();
        assert_eq!(cli.action, Action::Serve(ServeOptions { exit_on_stdin_close: true, ..ServeOptions::default() }));
        assert!(!ServeOptions::default().exit_on_stdin_close);
        assert!(parse(&["--stdio", "--exit-on-stdin-close"]).unwrap_err().contains("--exit-on-stdin-close"));
    }

    #[test]
    fn data_dir_prints_the_folder() {
        assert_eq!(parse(&["data-dir"]), Ok(Cli { action: Action::DataDir, data_dir: None }));
        assert_eq!(parse(&["data-dir", "--data-dir", "/d"]), Ok(Cli { action: Action::DataDir, data_dir: Some(PathBuf::from("/d")) }));
        assert!(parse(&["data-dir", "serve"]).unwrap_err().contains("data-dir"));
        assert!(parse(&["data-dir", "--attach"]).unwrap_err().contains("--attach"));
        assert!(parse(&["data-dir", "--port", "1"]).unwrap_err().contains("--port"));
    }

    #[test]
    fn devices_takes_its_own_words_and_the_data_dir() {
        let cli = parse(&["--data-dir", "/d", "devices", "tier", "abc", "full"]).unwrap();
        assert_eq!(cli, Cli { action: Action::Devices(crate::devices_cli::DevicesAction::Tier { id: "abc".into(), tier: crate::devices::Tier::Full }), data_dir: Some(PathBuf::from("/d")) });
        assert_eq!(parse(&["devices", "list", "--data-dir", "/d"]).unwrap().data_dir, Some(PathBuf::from("/d")));
        assert!(parse(&["devices"]).unwrap_err().contains("say list"));
    }

    #[test]
    fn help_and_version() {
        assert_eq!(parse(&["--help"]).unwrap().action, Action::Help);
        assert_eq!(parse(&["-h"]).unwrap().action, Action::Help);
        assert_eq!(parse(&["--version"]).unwrap().action, Action::Version);
    }

    #[test]
    fn mistakes_are_named() {
        assert!(parse(&[]).unwrap_err().contains("serve or --stdio"));
        assert!(parse(&["serve", "--stdio"]).unwrap_err().contains("serve or --stdio"));
        assert!(parse(&["--attach"]).unwrap_err().contains("--attach"));
        assert!(parse(&["serve", "--attach"]).unwrap_err().contains("--attach"));
        assert!(parse(&["--stdio", "--port", "1"]).unwrap_err().contains("--port"));
        assert!(parse(&["serve", "--port"]).unwrap_err().contains("--port"));
        assert!(parse(&["serve", "--port", "http"]).unwrap_err().contains("http"));
        assert!(parse(&["serve", "--bind", "localhost"]).unwrap_err().contains("localhost"));
        assert!(parse(&["serve", "--frobnicate"]).unwrap_err().contains("--frobnicate"));
        assert!(parse(&["--data-dir"]).unwrap_err().contains("--data-dir"));
    }
}
