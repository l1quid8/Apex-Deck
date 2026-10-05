//! The command line.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

pub const USAGE: &str = "\
usage: apex-daemon serve [--port N] [--bind ADDR] [--insecure-bind] [--data-dir PATH]
       apex-daemon --stdio [--attach] [--data-dir PATH]

  serve            run the host and listen on a localhost WebSocket and a local socket
  --stdio          speak the protocol on stdin/stdout (for SSH); attaches to a running
                   daemon when there is one, otherwise runs the host until the connection closes
  --attach         with --stdio: fail instead of running the host in this process
  --port N         WebSocket port (default: one the system picks, written to daemon.json)
  --bind ADDR      WebSocket address (default 127.0.0.1)
  --insecure-bind  allow a non-localhost --bind before device pairing exists
  --data-dir PATH  where chats and settings live (default: the desktop app's folder)";

/// What the daemon was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Serve(ServeOptions),
    Stdio { attach: bool },
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeOptions {
    /// 0 lets the system pick.
    pub port: u16,
    pub bind: IpAddr,
    pub insecure_bind: bool,
}

impl Default for ServeOptions {
    fn default() -> Self {
        ServeOptions { port: 0, bind: IpAddr::V4(Ipv4Addr::LOCALHOST), insecure_bind: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub action: Action,
    pub data_dir: Option<PathBuf>,
}

/// Read the arguments after the program name.
pub fn parse(args: &[String]) -> Result<Cli, String> {
    let mut serve = false;
    let mut stdio = false;
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
            other => return Err(format!("unknown argument {other}\n\n{USAGE}")),
        }
    }
    let action = if help {
        Action::Help
    } else if version {
        Action::Version
    } else if serve == stdio {
        return Err(format!("say serve or --stdio\n\n{USAGE}"));
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
        assert_eq!(cli.action, Action::Serve(ServeOptions { port: 7000, bind: "0.0.0.0".parse().unwrap(), insecure_bind: true }));
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
