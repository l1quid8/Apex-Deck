//! Whether the jail really holds on this machine, tested at each boot and
//! never carried over. A real jail tries five ways out and one way that must
//! work; a machine that fails runs no bot below Full.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub const PROBE_ARG: &str = "__jail-probe";

/// Each must stay shut. These names are what the person is told.
const HELD: [&str; 5] = ["data-folder", "daemon-socket", "host-loopback", "abstract-socket", "bound-socket"];
/// This one must work, so a jail that runs nothing at all can't pass.
const OUT: &str = "proxy";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JailState {
    Works,
    Fails(String),
}

pub const NEEDS_ADMIN: &str = "needs bubblewrap (admin)";

/// Reads the probe's report. Anything but all six lines counts as a failure,
/// so a probe that crashed part-way can't pass.
pub fn verdict(report: &str) -> JailState {
    let said = |name: &str| report.lines().find_map(|line| {
        let (check, state) = line.split_once(' ')?;
        (check == name).then_some(state)
    });
    let open: Vec<&str> = HELD.into_iter().filter(|name| said(name) != Some("shut")).collect();
    if !open.is_empty() { return JailState::Fails(format!("{NEEDS_ADMIN}: the sandbox let a test through: {}", open.join(", "))); }
    if said(OUT) != Some("open") { return JailState::Fails(format!("{NEEDS_ADMIN}: the sandbox's web proxy didn't answer")); }
    JailState::Works
}

/// `apex-daemon __jail-probe <marker> <socket> <loopback port> <abstract name> <bound socket>`:
/// the jail's side. Prints one line per check and always exits cleanly, since
/// the daemon reads the lines, not the status.
#[cfg(target_os = "linux")]
pub fn main() -> ! {
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpStream};
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixStream};
    use std::time::Duration;

    let args: Vec<String> = std::env::args().skip(2).collect();
    let [marker, socket, loopback, abstract_name, bound] = args.as_slice() else { std::process::exit(2) };
    let wait = Duration::from_secs(2);
    let tcp = |port: u16| TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), wait);
    let reached = [
        std::fs::read(marker).is_ok(),
        UnixStream::connect(socket).is_ok(),
        loopback.parse().is_ok_and(|port| tcp(port).is_ok()),
        SocketAddr::from_abstract_name(abstract_name).is_ok_and(|addr| UnixStream::connect_addr(&addr).is_ok()),
        UnixStream::connect(bound).is_ok(),
    ];
    for (name, reached) in HELD.iter().zip(reached) {
        println!("{name} {}", if reached { "open" } else { "shut" });
    }
    let through = || -> std::io::Result<bool> {
        let mut stream = tcp(super::PROXY_PORT)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(format!("CONNECT {PROBE_HOST}:443 HTTP/1.1\r\n\r\n{PING}").as_bytes())?;
        let (mut seen, mut chunk) = (Vec::new(), [0u8; 256]);
        while !seen.ends_with(PING.as_bytes()) {
            let read = stream.read(&mut chunk)?;
            if read == 0 { return Ok(false); }
            seen.extend_from_slice(&chunk[..read]);
        }
        Ok(seen.starts_with(b"HTTP/1.1 200 "))
    };
    println!("{OUT} {}", if through().unwrap_or(false) { "open" } else { "shut" });
    std::process::exit(0)
}

const PROBE_HOST: &str = "apex-probe.invalid";
const PING: &str = "ping";
#[cfg(target_os = "linux")]
const LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

pub struct ProbeEnv {
    /// The daemon's own binary.
    pub init: std::path::PathBuf,
    pub home: std::path::PathBuf,
    pub data: std::path::PathBuf,
}

/// The daemon's side of the test. `bwrap` is what `gateway_sandbox::find_bwrap`
/// found. The proxy is the real one with a stand-in network, so a boot with no
/// internet yet doesn't count as a broken sandbox.
#[cfg(target_os = "linux")]
pub async fn run(env: &ProbeEnv, bwrap: Option<&std::path::Path>) -> JailState {
    let Some(bwrap) = bwrap else { return JailState::Fails(format!("{NEEDS_ADMIN}: it isn't installed")) };
    match tokio::time::timeout(LIMIT, attempt(env, bwrap)).await {
        Ok(Ok(state)) => state,
        Ok(Err(why)) => JailState::Fails(format!("{NEEDS_ADMIN}: {why}")),
        Err(_) => JailState::Fails(format!("{NEEDS_ADMIN}: the sandbox test didn't finish")),
    }
}

#[cfg(target_os = "linux")]
pub async fn run_installed(env: &ProbeEnv) -> JailState {
    let bwrap = crate::gateway_sandbox::find_bwrap(None);
    run(env, bwrap.as_deref()).await
}

#[cfg(target_os = "linux")]
mod host {
    use super::super::{channel, launch, paths, proxy, Bind, JailError, JailSpec, INIT_PATH};
    use super::{verdict, JailState, ProbeEnv, PROBE_ARG};
    use crate::owned_process::Registry;
    use std::io;
    use std::net::{IpAddr, SocketAddr, TcpListener};
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{self, UnixListener};
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, DuplexStream};
    use tokio::net::UnixStream;

    /// Removes the test's files on every way out, a time-out included.
    struct Scratch { data: PathBuf, bound: PathBuf }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data);
            let _ = std::fs::remove_dir_all(&self.bound);
        }
    }

    struct Standin;

    #[async_trait::async_trait]
    impl proxy::Net for Standin {
        type Upstream = DuplexStream;
        async fn lookup(&self, _: &str) -> io::Result<Vec<IpAddr>> { Ok(vec![IpAddr::from([1, 1, 1, 1])]) }
        fn own_addrs(&self) -> io::Result<Vec<IpAddr>> { Ok(Vec::new()) }
        async fn dial(&self, _: SocketAddr) -> io::Result<DuplexStream> {
            let (near, mut far) = tokio::io::duplex(1024);
            tokio::spawn(async move {
                let (mut from, mut to) = tokio::io::split(&mut far);
                let _ = tokio::io::copy(&mut from, &mut to).await;
            });
            Ok(near)
        }
    }

    #[async_trait::async_trait]
    impl channel::Purposes for Standin {
        async fn proxy(&self, stream: UnixStream) { proxy::serve(stream, &Standin).await }
        async fn codex_hook(&self, _: UnixStream) {}
    }

    /// Ends the channel on every way out; a dropped handle alone wouldn't.
    struct Aborted(tokio::task::JoinHandle<()>);
    impl Drop for Aborted { fn drop(&mut self) { self.0.abort(); } }

    /// A fresh, private folder in the real `/tmp`: `$TMPDIR` can be too long for a socket.
    fn bound_folder() -> io::Result<PathBuf> {
        use std::os::unix::fs::DirBuilderExt;
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        let path = PathBuf::from(format!("/tmp/apex-probe-{}-{unique}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(path)
    }

    pub(super) async fn attempt(env: &ProbeEnv, bwrap: &Path) -> Result<JailState, String> {
        let words = |error: io::Error| error.to_string();
        let jail_words = |error: JailError| error.to_string();
        let data = env.data.join("probe");
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("home")).map_err(words)?;
        let scratch = Scratch { data, bound: bound_folder().map_err(words)? };
        let marker = scratch.data.join("marker");
        std::fs::write(&marker, "not for bots").map_err(words)?;
        let socket = scratch.data.join("s");
        let bound_socket = scratch.bound.join("s");
        let _socket = UnixListener::bind(&socket).map_err(words)?;
        let _bound = UnixListener::bind(&bound_socket).map_err(words)?;
        let loopback = TcpListener::bind(("127.0.0.1", 0)).map_err(words)?;
        let port = loopback.local_addr().map_err(words)?.port();
        let name = format!("apex-probe-{}-{port}", std::process::id());
        let _abstract = UnixListener::bind_addr(&net::SocketAddr::from_abstract_name(&name).map_err(words)?).map_err(words)?;

        let args = [PROBE_ARG.to_owned(), marker.display().to_string(), socket.display().to_string(), port.to_string(), name, bound_socket.display().to_string()];
        let spec = JailSpec {
            program: INIT_PATH.into(),
            args: args.into(),
            cwd: scratch.bound.clone(),
            home: env.home.clone(),
            private_home: scratch.data.join("home"),
            folders: vec![Bind { source: scratch.bound.clone(), target: scratch.bound.clone(), writable: false }],
            read_only: Vec::new(),
            protected: paths::standard_protected(&env.home, &env.data),
            restored: Vec::new(),
            init: env.init.clone(),
            path: "/usr/bin:/bin".into(),
            provider_env: Vec::new(),
            seccomp_fd: -1,
            control_fd: -1,
        };
        let mut jailed = launch::jailed_command(&spec, bwrap).map_err(jail_words)?;
        jailed.command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child, control) = jailed.spawn(&Registry::default()).map_err(words)?;
        let _serve = Aborted(tokio::spawn(channel::serve(control, Arc::new(Standin))));
        let (mut out, mut err) = (child.stdout.take().ok_or("no output")?, child.stderr.take().ok_or("no output")?);
        let (mut report, mut problem) = (String::new(), String::new());
        let (_, _, status) = tokio::join!(out.read_to_string(&mut report), err.read_to_string(&mut problem), child.wait());
        if !status.map_err(words)?.success() {
            let why = problem.lines().last().unwrap_or("it exited early");
            return Err(format!("the sandbox couldn't start: {why}"));
        }
        Ok(verdict(&report))
    }
}

#[cfg(target_os = "linux")]
use host::attempt;

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "data-folder shut\ndaemon-socket shut\nhost-loopback shut\nabstract-socket shut\nbound-socket shut\nproxy open\n";

    #[test]
    fn all_six_right_is_the_only_pass() {
        assert_eq!(verdict(GOOD), JailState::Works);
    }

    #[test]
    fn any_way_out_fails_and_is_named() {
        for name in HELD {
            let report = GOOD.replace(&format!("{name} shut"), &format!("{name} open"));
            let JailState::Fails(why) = verdict(&report) else { panic!("{name} passed") };
            assert!(why.contains(name), "{why}");
        }
    }

    #[test]
    fn a_report_cut_short_fails() {
        for keep in 0..GOOD.lines().count() {
            let report = GOOD.lines().take(keep).collect::<Vec<_>>().join("\n");
            assert!(matches!(verdict(&report), JailState::Fails(_)), "{keep} lines passed");
        }
    }

    #[test]
    fn a_proxy_that_is_shut_fails() {
        let report = GOOD.replace("proxy open", "proxy shut");
        assert!(matches!(verdict(&report), JailState::Fails(_)));
    }
}
