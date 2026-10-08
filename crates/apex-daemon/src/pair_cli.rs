//! `apex-daemon pair`: pair a phone from a terminal, and `apex-daemon
//! remote …`: see remote access and set the addresses it advertises.
//!
//! `pair` talks to the running daemon over its local socket: `pair_start`,
//! the QR and link, `pair_wait` for a phone, the phone's name and code,
//! `Approve? [y/N]`, then `pair_approve` or `pair_cancel`. Ctrl-C cancels
//! the invitation before exiting.

#[cfg(feature = "remote")]
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::json;
#[cfg(feature = "remote")]
use serde_json::Value;

use crate::devices::Tier;
use crate::local_call;
#[cfg(feature = "remote")]
use crate::local_call::{Client, Refused};
use crate::{paths, remote_config, serve};

pub const USAGE: &str = "\
usage: apex-daemon pair [--tier read_only|chat|full] [--threads all|ID,ID]
       apex-daemon remote info
       apex-daemon remote advertise <host:port>… | --clear

  pair       show a QR code for the Apex Deck phone app to scan, then approve the
             phone that claims it (the daemon must be running with --remote)
  --tier     what the phone may do: read_only, chat (default) or full
  --threads  which threads it may reach: all (default) or a list of IDs
  remote info
             whether remote access is on, its endpoint ID, UDP port and advertised addresses
  remote advertise
             addresses a phone may also dial (a DDNS name with a forwarded UDP port, say);
             they go into the QR code. --clear removes them";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairOptions {
    pub tier: Tier,
    /// `None` is every thread.
    pub threads: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteAction {
    Info,
    /// Replace the advertised addresses; empty clears them.
    Advertise(Vec<String>),
}

fn usage(why: impl std::fmt::Display) -> String {
    format!("{why}\n\n{USAGE}")
}

/// Read what follows `pair`.
pub fn parse(args: &[String]) -> Result<PairOptions, String> {
    let mut options = PairOptions { tier: Tier::Chat, threads: None };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = || args.next().cloned().ok_or_else(|| usage(format!("{arg} needs a value")));
        match arg.as_str() {
            "--tier" => options.tier = Tier::parse(&value()?)?,
            "--threads" => {
                let list = value()?;
                options.threads = (list != "all").then(|| list.split(',').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect());
                if options.threads.as_ref().is_some_and(Vec::is_empty) {
                    return Err(usage("--threads needs all or a list of thread IDs"));
                }
            }
            other => return Err(usage(format!("unknown argument {other}"))),
        }
    }
    Ok(options)
}

/// Read what follows `remote`.
pub fn parse_remote(args: &[String]) -> Result<RemoteAction, String> {
    match args.first().map(String::as_str) {
        Some("info") if args.len() == 1 => Ok(RemoteAction::Info),
        Some("advertise") if args.len() == 2 && args[1] == "--clear" => Ok(RemoteAction::Advertise(Vec::new())),
        Some("advertise") if args.len() >= 2 && !args[1..].iter().any(|a| a == "--clear") => {
            let addrs = remote_config::check_all(&args[1..]).map_err(usage)?;
            Ok(RemoteAction::Advertise(addrs))
        }
        _ => Err(usage("say remote info, remote advertise <host:port>… or remote advertise --clear")),
    }
}

/// `remote info` / `remote advertise`: through the daemon when it runs,
/// else on `remote.json` directly.
pub fn run_remote(data_dir: Option<PathBuf>, action: RemoteAction) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let request = match &action {
        RemoteAction::Info => json!({ "cmd": "remote_info", "args": {} }),
        RemoteAction::Advertise(addrs) => json!({ "cmd": "remote_advertise", "args": { "addrs": addrs } }),
    };
    let answer = match std::os::unix::net::UnixStream::connect(paths.data.join(serve::SOCKET)) {
        Ok(socket) => local_call::through_daemon(socket, request)?,
        Err(_) => match action {
            RemoteAction::Info => json!({ "enabled": false, "endpoint_id": null, "port": remote_config::port(&paths.data), "advertise": remote_config::advertised(&paths.data) }),
            RemoteAction::Advertise(addrs) => {
                std::fs::create_dir_all(&paths.data).map_err(|e| format!("could not create {}: {e}", paths.data.display()))?;
                json!({ "advertise": remote_config::set_advertised(&paths.data, &addrs)? })
            }
        },
    };
    println!("{}", serde_json::to_string_pretty(&answer).map_err(|e| e.to_string())?);
    Ok(())
}

/// `apex-daemon pair`.
#[cfg(feature = "remote")]
pub fn run(data_dir: Option<PathBuf>, options: PairOptions) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let socket = std::os::unix::net::UnixStream::connect(paths.data.join(serve::SOCKET))
        .map_err(|_| format!("no daemon is running for {}. Start it with `apex-daemon serve --remote`, then try again.", paths.data.display()))?;
    socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let result = runtime.block_on(async {
        // Listening from the start, so an early Ctrl-C is ours to handle.
        let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).map_err(|e| format!("could not listen for Ctrl-C: {e}"))?;
        let stream = tokio::net::UnixStream::from_std(socket).map_err(|e| e.to_string())?;
        let mut client = Client::hello(stream).await.map_err(|r| r.err)?;
        let stdin = std::io::BufReader::new(std::io::stdin());
        pair(&mut client, &options, &mut std::io::stdout(), stdin, async move {
            interrupt.recv().await;
        })
        .await
    });
    // A thread may still be waiting on stdin; don't wait for it.
    runtime.shutdown_background();
    result
}

#[cfg(not(feature = "remote"))]
pub fn run(_data_dir: Option<PathBuf>, _options: PairOptions) -> Result<(), String> {
    Err("this apex-daemon was built without remote access (cargo feature `remote`)".into())
}

/// The QR code for `link`, in Unicode half blocks. Light modules are drawn,
/// so it reads right on a dark terminal, with the quiet zone around it.
#[cfg(feature = "remote")]
pub fn qr(link: &str) -> Result<String, String> {
    use qrcode::render::unicode::Dense1x2;
    // Low error correction keeps it small enough for 80 columns; a screen
    // doesn't smudge.
    let code = qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::L).map_err(|e| format!("could not make the QR code: {e}"))?;
    Ok(code.render::<Dense1x2>().dark_color(Dense1x2::Light).light_color(Dense1x2::Dark).quiet_zone(true).build())
}

/// How long ago `at` (ms since the epoch) was, in words.
#[cfg(feature = "remote")]
fn ago(at: u64) -> String {
    let minutes = crate::devices::now_ms().saturating_sub(at) / 60_000;
    match minutes {
        0 => "just now".into(),
        1 => "a minute ago".into(),
        m if m < 120 => format!("{m} minutes ago"),
        m if m < 48 * 60 => format!("{} hours ago", m / 60),
        m => format!("{} days ago", m / (24 * 60)),
    }
}

/// Run the pairing over `client`: start, show the QR and link on `out`,
/// wait for a phone, ask on `stdin`, then approve or cancel. When
/// `interrupted` resolves (Ctrl-C) before the end, the invitation is
/// cancelled.
#[cfg(feature = "remote")]
pub async fn pair<W, R>(client: &mut Client, options: &PairOptions, out: &mut W, stdin: R, interrupted: impl std::future::Future<Output = ()>) -> Result<(), String>
where
    W: Write,
    R: BufRead + Send + 'static,
{
    let say = |out: &mut W, text: &str| -> Result<(), String> {
        out.write_all(text.as_bytes()).and_then(|()| out.flush()).map_err(|e| e.to_string())
    };
    let threads = options.threads.as_ref().map_or(json!("all"), |t| json!(t));
    let started = client.call("pair_start", json!({ "tier": options.tier, "threads": threads })).await.map_err(|r| r.err)?;
    let (invitation, link) = (started["invitation"].clone(), started["link"].as_str().unwrap_or_default().to_string());
    let minutes = started["expires_at"].as_u64().unwrap_or(0).saturating_sub(crate::devices::now_ms()).div_ceil(60_000);
    let scope = options.threads.as_ref().map_or("every thread".to_string(), |t| format!("threads {}", t.join(", ")));
    say(out, &format!(
        "{}\nScan this with the Apex Deck app on your phone, or paste this link into it:\n{link}\n\nThe phone gets {} access to {scope}. The code expires in {minutes} minutes; Ctrl-C cancels.\nWaiting for a phone…\n",
        qr(&link)?,
        tier_name(options.tier),
    ))?;

    tokio::pin!(interrupted);

    let waiting = client.send("pair_wait", json!({ "invitation": invitation })).await.map_err(|r| r.err)?;
    let claim = tokio::select! {
        claim = client.reply(waiting) => claim,
        _ = &mut interrupted => {
            cancel(client, &invitation).await;
            return Err("cancelled; no phone was paired".into());
        }
    };
    let claim = claim.map_err(|Refused { err, .. }| err)?;
    let label = claim["label"].as_str().unwrap_or("A phone").to_string();
    let mut text = format!("\n{label} wants to pair.\nCode: {}\nCheck that the phone shows the same code.\n", claim["code"].as_str().unwrap_or_default());
    if let Some(at) = claim["previously_revoked_at"].as_u64() {
        text.push_str(&format!("Warning: this phone was revoked here {}. Approving lets it back in.\n", ago(at)));
    }
    text.push_str("Approve? [y/N] ");
    say(out, &text)?;

    let (answer_tx, answer_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut stdin = stdin;
        let mut line = String::new();
        let read = stdin.read_line(&mut line).map(|_| line);
        let _ = answer_tx.send(read.ok());
    });
    let answer = tokio::select! {
        answer = answer_rx => answer.ok().flatten().unwrap_or_default(),
        _ = &mut interrupted => {
            cancel(client, &invitation).await;
            return Err("cancelled; the phone was not paired".into());
        }
    };
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        cancel(client, &invitation).await;
        return Err(format!("not approved; {label} was not paired"));
    }
    let approved = client.call("pair_approve", json!({ "invitation": invitation, "claim_id": claim["claim_id"] })).await.map_err(|r| r.err)?;
    let device: &Value = &approved["device"];
    say(out, &format!("Paired {label} with {} access. Manage it with `apex-daemon devices`.\n", tier_name(serde_json::from_value(device["tier"].clone()).unwrap_or(options.tier))))
}

/// Give the invitation up; a phone holding it is told at once.
#[cfg(feature = "remote")]
async fn cancel(client: &mut Client, invitation: &Value) {
    let _ = client.call("pair_cancel", json!({ "invitation": invitation })).await;
}

#[cfg(feature = "remote")]
fn tier_name(tier: Tier) -> &'static str {
    match tier {
        Tier::ReadOnly => "read-only",
        Tier::Chat => "chat",
        Tier::Full => "full",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<PairOptions, String> {
        super::parse(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    fn parse_remote(args: &[&str]) -> Result<RemoteAction, String> {
        super::parse_remote(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn pair_takes_a_tier_and_threads() {
        assert_eq!(parse(&[]), Ok(PairOptions { tier: Tier::Chat, threads: None }));
        assert_eq!(parse(&["--tier", "full", "--threads", "all"]), Ok(PairOptions { tier: Tier::Full, threads: None }));
        assert_eq!(parse(&["--threads", "r1, r2", "--tier", "read_only"]), Ok(PairOptions { tier: Tier::ReadOnly, threads: Some(vec!["r1".into(), "r2".into()]) }));
    }

    #[test]
    fn pair_mistakes_are_named() {
        assert!(parse(&["--tier", "admin"]).unwrap_err().contains("admin"));
        assert!(parse(&["--tier"]).unwrap_err().contains("--tier needs a value"));
        assert!(parse(&["--threads", ","]).unwrap_err().contains("--threads"));
        assert!(parse(&["--label", "x"]).unwrap_err().contains("--label"));
        assert!(parse(&["now"]).unwrap_err().contains("now"));
    }

    #[test]
    fn remote_info_and_advertise() {
        assert_eq!(parse_remote(&["info"]), Ok(RemoteAction::Info));
        assert_eq!(parse_remote(&["advertise", "--clear"]), Ok(RemoteAction::Advertise(vec![])));
        assert_eq!(parse_remote(&["advertise", "MyHome.ddns.net:41641", "[::1]:2"]), Ok(RemoteAction::Advertise(vec!["myhome.ddns.net:41641".into(), "[::1]:2".into()])));
        assert!(parse_remote(&["advertise", "nonsense"]).unwrap_err().contains("host:port"));
        assert!(parse_remote(&["advertise"]).is_err());
        assert!(parse_remote(&["advertise", "a.example:1", "--clear"]).is_err());
        assert!(parse_remote(&[]).unwrap_err().contains("remote info"));
    }

    /// Without a daemon, `remote advertise` changes the file itself.
    #[test]
    fn without_a_daemon_advertise_changes_the_file() {
        let data = crate::devices::tests::folder();
        run_remote(Some(data.0.clone()), RemoteAction::Advertise(vec!["a.example:1".into()])).unwrap();
        assert_eq!(remote_config::advertised(&data.0), vec!["a.example:1".to_string()]);
        run_remote(Some(data.0.clone()), RemoteAction::Advertise(vec![])).unwrap();
        assert!(remote_config::advertised(&data.0).is_empty());
    }

    /// The QR's width in columns for a link with `addrs`.
    #[cfg(feature = "remote")]
    fn qr_width(addrs: &[&str]) -> usize {
        let addrs = addrs.iter().map(|a| a.to_string()).collect();
        let invite = crate::pairing::Invite { v: 1, host: [7; 32], name: "Tyler's Mac Studio".into(), relay: crate::remote::RELAY.into(), addrs, inv: [1; 16], secret: [2; 32], exp: 1_791_400_000 };
        let code = qr(&invite.to_link()).unwrap();
        assert_eq!(code.lines().count() * 2, code.lines().map(|l| l.chars().count()).max().unwrap() + 1, "square, two rows per line");
        code.lines().map(|l| l.chars().count()).max().unwrap()
    }

    /// With the standard 4-module quiet zone, a LAN address and an
    /// advertised one take about 81 columns; four addresses still fit 100.
    #[cfg(feature = "remote")]
    #[test]
    fn the_qr_fits_a_terminal() {
        let two = qr_width(&["192.168.50.14:41641", "myhome.ddns.net:41641"]);
        assert!(two <= 90, "{two} columns");
        assert!(qr_width(&["192.168.50.14:41641", "10.0.0.2:41641", "[fd00::1234:5678:9abc:def0]:41641", "myhome.ddns.net:41641"]) <= 100);
    }

    #[cfg(feature = "remote")]
    mod live {
        use super::super::*;
        use std::net::SocketAddr;
        use std::path::Path;
        use std::sync::Arc;

        use apex_host::{Host, HostPaths};
        use iroh::{Endpoint, SecretKey};
        use tokio::sync::mpsc;

        use crate::devices::{Devices, Threads};
        use crate::pairing::invites::PairError;
        use crate::pairing::Invite;
        use crate::protocol::{self, Daemon, Trust};
        use crate::remote::{self, close, pair_phone::pair_dial};

        /// A daemon serving `--remote` (no relay) and its local socket.
        async fn live_daemon(data: &Path) -> (Arc<Daemon>, std::path::PathBuf, SocketAddr) {
            let host = Host::new(HostPaths { data: data.to_path_buf(), downloads: None }, tokio::runtime::Handle::current());
            let daemon = Arc::new(Daemon {
                host, host_id: "host-1".into(), boot_id: "boot-1".into(), token: None, devices: Arc::new(Devices::open(data)), data: data.to_path_buf(),
                invites: Default::default(), endpoint: Default::default(),
            });
            let endpoint: Endpoint = remote::bind(remote::key(data).unwrap(), None, 0).await.unwrap();
            let port = endpoint.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
            daemon.endpoint.set(endpoint.clone()).unwrap();
            tokio::spawn(remote::accept(Arc::clone(&daemon), endpoint));
            let socket = data.join(serve::SOCKET);
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let serving = Arc::clone(&daemon);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (read, write) = stream.into_split();
                    let (input, output) = protocol::lines(read, write);
                    tokio::spawn(protocol::serve(Arc::clone(&serving), Trust::Local, input, output));
                }
            });
            (daemon, socket, SocketAddr::from(([127, 0, 0, 1], port)))
        }

        /// What the CLI prints, line by line.
        struct Screen(mpsc::UnboundedSender<String>, String);

        impl Write for Screen {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.1.push_str(&String::from_utf8_lossy(bytes));
                while let Some(end) = self.1.find('\n') {
                    let line: String = self.1.drain(..=end).collect();
                    let _ = self.0.send(line.trim_end().to_string());
                }
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                if !self.1.is_empty() {
                    let _ = self.0.send(std::mem::take(&mut self.1));
                }
                Ok(())
            }
        }

        /// Run `pair` against the daemon's socket with `stdin`; the lines it
        /// prints come out of the receiver.
        async fn run_cli(socket: &Path, options: PairOptions, stdin: &'static str, interrupted: tokio::sync::oneshot::Receiver<()>) -> (tokio::task::JoinHandle<Result<(), String>>, mpsc::UnboundedReceiver<String>) {
            let stream = tokio::net::UnixStream::connect(socket).await.unwrap();
            let (tx, rx) = mpsc::unbounded_channel();
            let cli = tokio::spawn(async move {
                let mut client = Client::hello(stream).await.map_err(|r| r.err)?;
                let mut screen = Screen(tx, String::new());
                pair(&mut client, &options, &mut screen, std::io::Cursor::new(stdin), async move {
                    if interrupted.await.is_err() {
                        std::future::pending::<()>().await;
                    }
                })
                .await
            });
            (cli, rx)
        }

        async fn link_from(screen: &mut mpsc::UnboundedReceiver<String>) -> Invite {
            loop {
                let line = tokio::time::timeout(std::time::Duration::from_secs(10), screen.recv()).await.expect("the link in time").expect("the CLI printed a link");
                if line.starts_with("apexdeck://pair?p=") {
                    return Invite::parse_link(&line, crate::devices::now_ms() / 1000).unwrap();
                }
            }
        }

        async fn rest(screen: &mut mpsc::UnboundedReceiver<String>) -> String {
            let mut all = String::new();
            while let Some(line) = screen.recv().await {
                all.push_str(&line);
                all.push('\n');
            }
            all
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn a_phone_that_claims_is_paired_when_the_terminal_says_y() {
            let data = crate::devices::tests::folder();
            let (daemon, socket, at) = live_daemon(&data.0).await;
            remote_config::set_advertised(&data.0, &["myhome.ddns.net:41641".into()]).unwrap();
            let (_never, interrupted) = tokio::sync::oneshot::channel();
            let options = PairOptions { tier: Tier::Full, threads: Some(vec!["r1".into()]) };
            let (cli, mut screen) = run_cli(&socket, options, "y\n", interrupted).await;
            let invite = link_from(&mut screen).await;
            assert_eq!(&invite.host, daemon.endpoint.get().unwrap().id().as_bytes());
            assert_eq!(invite.relay, remote::RELAY);
            assert!(invite.addrs.contains(&"myhome.ddns.net:41641".to_string()), "{:?}", invite.addrs);

            let phone = SecretKey::generate();
            let ok = pair_dial(phone.clone(), at, &invite).await.expect("paired");
            assert_eq!((ok["tier"].clone(), ok["threads"].clone()), (json!("full"), json!(["r1"])));
            assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(10), cli).await.unwrap().unwrap(), Ok(()));
            let printed = rest(&mut screen).await;
            assert!(printed.contains("Tyler's iPhone wants to pair.") && printed.contains("Code: ") && printed.contains("Approve? [y/N]"), "{printed}");
            assert!(printed.contains("Paired Tyler's iPhone with full access"), "{printed}");
            let device = daemon.devices.get(&phone.public().to_string()).expect("in the registry");
            assert_eq!((device.label.as_str(), device.tier, device.threads), ("Tyler's iPhone", Tier::Full, Threads::Only(vec!["r1".into()])));
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn anything_but_y_denies_the_phone() {
            let data = crate::devices::tests::folder();
            let (daemon, socket, at) = live_daemon(&data.0).await;
            let (_never, interrupted) = tokio::sync::oneshot::channel();
            let (cli, mut screen) = run_cli(&socket, PairOptions { tier: Tier::Chat, threads: None }, "\n", interrupted).await;
            let invite = link_from(&mut screen).await;
            let phone = SecretKey::generate();
            let refused = pair_dial(phone.clone(), at, &invite).await.expect_err("denied");
            assert_eq!(refused.0, close::PAIR_DENIED, "{refused:?}");
            assert!(cli.await.unwrap().unwrap_err().contains("not approved"));
            assert!(daemon.devices.get(&phone.public().to_string()).is_none());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn ctrl_c_cancels_the_invitation() {
            let data = crate::devices::tests::folder();
            let (daemon, socket, at) = live_daemon(&data.0).await;
            let (interrupt, interrupted) = tokio::sync::oneshot::channel();
            let (cli, mut screen) = run_cli(&socket, PairOptions { tier: Tier::Chat, threads: None }, "y\n", interrupted).await;
            let invite = link_from(&mut screen).await;
            interrupt.send(()).unwrap();
            assert!(cli.await.unwrap().unwrap_err().contains("cancelled"));
            assert_eq!(daemon.invites.wait(&invite.inv).await, Err(PairError::Cancelled));
            let refused = pair_dial(SecretKey::generate(), at, &invite).await.expect_err("nothing to claim");
            assert_eq!(refused.0, close::PAIR_UNKNOWN, "{refused:?}");
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn without_remote_access_pair_says_how_to_turn_it_on() {
            // A daemon that isn't serving --remote.
            let data = crate::devices::tests::folder();
            let host = Host::new(HostPaths { data: data.0.clone(), downloads: None }, tokio::runtime::Handle::current());
            let off = Arc::new(Daemon { host, host_id: "h".into(), boot_id: "b".into(), token: None, devices: Arc::new(Devices::open(&data.0)), data: data.0.clone(), invites: Default::default(), endpoint: Default::default() });
            let (ours, theirs) = tokio::net::UnixStream::pair().unwrap();
            let (read, write) = theirs.into_split();
            let (input, output) = protocol::lines(read, write);
            tokio::spawn(protocol::serve(off, Trust::Local, input, output));
            let mut client = Client::hello(ours).await.unwrap();
            let mut out = Vec::new();
            let err = pair(&mut client, &PairOptions { tier: Tier::Chat, threads: None }, &mut out, std::io::Cursor::new(""), std::future::pending()).await.unwrap_err();
            assert!(err.contains("apex-daemon serve --remote"), "{err}");
        }
    }
}
