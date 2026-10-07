//! Loopback tests against the real daemon (no relay).
use super::*;
use apex_daemon::{
    devices::{Devices, Threads, Tier},
    pairing::invites::HostInfo,
    protocol::Daemon,
    remote,
};
use apex_host::{Host, HostPaths};
use std::{path::PathBuf, time::Instant};

/// A throwaway data folder, removed on drop.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        let mut n = [0u8; 8];
        getrandom(&mut n);
        let p = std::env::temp_dir().join(format!("apex-remote-test-{}", n.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        std::fs::create_dir_all(&p).unwrap();
        Folder(p)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn getrandom(buf: &mut [u8]) {
    let k = SecretKey::generate();
    for (i, b) in buf.iter_mut().enumerate() {
        *b = k.to_bytes()[i % 32];
    }
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// Every event the bridge sent, in order.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<Value>>>);

impl Events {
    fn sink(&self) -> Sink {
        let all = Arc::clone(&self.0);
        Arc::new(move |e: &str| all.lock().unwrap().push(serde_json::from_str(e).unwrap()))
    }

    fn of(&self, handle: u64) -> Vec<Value> {
        self.0.lock().unwrap().iter().filter(|e| e["handle"] == handle).cloned().collect()
    }

    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    /// Wait until `handle` has an event of `kind`, and return it.
    async fn wait(&self, handle: u64, kind: &str, within: Duration) -> Value {
        let until = Instant::now() + within;
        loop {
            if let Some(e) = self.of(handle).into_iter().find(|e| e["type"] == kind) {
                return e;
            }
            assert!(Instant::now() < until, "no {kind} for {handle}; got {:?}", self.of(handle));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The handle's events end with exactly one `closed`.
    fn assert_closed_once(&self, handle: u64) -> Value {
        let mine = self.of(handle);
        let closed: Vec<_> = mine.iter().enumerate().filter(|(_, e)| e["type"] == "closed").collect();
        assert_eq!(closed.len(), 1, "one closed for {handle}: {mine:?}");
        assert_eq!(closed[0].0, mine.len() - 1, "nothing after closed for {handle}: {mine:?}");
        closed[0].1.clone()
    }
}

async fn bridge(mode: Mode) -> (Bridge, Events, String) {
    let events = Events::default();
    let b = Bridge::new(tokio::runtime::Handle::current(), None, events.sink());
    let key = SecretKey::generate();
    let id = b.set_mode(Zeroizing::new(key.to_bytes()), mode).await.unwrap();
    assert_eq!(id, key.public().to_string());
    (b, events, id)
}

struct Server {
    daemon: Arc<Daemon>,
    endpoint: Endpoint,
    _data: Folder,
}

impl Server {
    async fn start() -> Server {
        let data = Folder::new();
        let host = Host::new(HostPaths { data: data.0.clone(), downloads: None }, tokio::runtime::Handle::current());
        let daemon = Arc::new(Daemon {
            host,
            host_id: "host-1".into(),
            boot_id: "boot-1".into(),
            token: None,
            devices: Arc::new(Devices::open(&data.0)),
            data: data.0.clone(),
            invites: Default::default(),
            endpoint: Default::default(),
        });
        let endpoint = remote::bind(remote::key(&data.0).unwrap(), None, 0).await.unwrap();
        tokio::spawn(remote::accept(Arc::clone(&daemon), endpoint.clone()));
        Server { daemon, endpoint, _data: data }
    }

    fn addr(&self) -> String {
        let port = self.endpoint.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
        format!("127.0.0.1:{port}")
    }

    fn id(&self) -> String {
        self.endpoint.id().to_string()
    }

    fn pair_phone(&self, id: &str) {
        self.daemon.devices.add(id, "Phone", Tier::Full, Threads::ALL, false).unwrap();
    }

    /// An invitation naming `host`, reachable at this server.
    fn invite(&self, host: [u8; 32]) -> Invite {
        let info = HostInfo { host, name: "Test Mac".into(), relay: RELAY.into(), addrs: vec![self.addr()] };
        self.daemon.invites.start(info, Tier::Chat, Threads::ALL, apex_daemon::devices::now_ms())
    }
}

/// A UDP port that swallows everything, so a dial to it hangs.
fn black_hole() -> (std::net::UdpSocket, String) {
    let s = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let a = s.local_addr().unwrap().to_string();
    (s, a)
}

const HELLO: &str = r#"{"id":0,"cmd":"hello","args":{"protocol":1}}"#;

#[tokio::test(flavor = "multi_thread")]
async fn two_connections_on_two_handles() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::Automatic).await;
    server.pair_phone(&id);
    let one = b.connect(&server.id(), &[server.addr()]).unwrap();
    let two = b.connect(&server.id(), &[server.addr()]).unwrap();
    assert_ne!(one, two);
    for h in [one, two] {
        events.wait(h, "opened", Duration::from_secs(10)).await;
        b.send(h, HELLO.into()).unwrap();
    }
    for h in [one, two] {
        let line = events.wait(h, "line", Duration::from_secs(10)).await;
        let v: Value = serde_json::from_str(line["line"].as_str().unwrap()).unwrap();
        assert_eq!(v["ok"]["host_id"], "host-1");
        let route = events.wait(h, "route", Duration::from_secs(1)).await;
        assert_eq!(route["route"], "direct");
    }
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn close_during_a_hanging_connect_is_quick_and_final() {
    let (hole, addr) = black_hole();
    let (b, events, _) = bridge(Mode::Automatic).await;
    let host = SecretKey::generate().public().to_string();
    let started = Instant::now();
    let h = b.connect(&host, &[addr]).unwrap();
    assert!(started.elapsed() < Duration::from_millis(200), "connect returned before dialing");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let closing = Instant::now();
    b.close(h);
    assert!(closing.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let closed = events.assert_closed_once(h);
    assert_eq!(closed["code"], close::CLOSED);
    assert!(events.of(h).iter().all(|e| e["type"] != "opened"));
    drop(hole);
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pair_cancel_mid_pair_is_quick_and_final() {
    let (hole, addr) = black_hole();
    let (b, events, _) = bridge(Mode::Automatic).await;
    let invite = Invite { v: 1, host: *SecretKey::generate().public().as_bytes(), name: "Nowhere".into(), relay: RELAY.into(), addrs: vec![addr], inv: [7; 16], secret: [9; 32], exp: now_s() + 300 };
    let h = b.pair(&invite.to_link(), "Phone", now_s()).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let closing = Instant::now();
    b.close(h);
    assert!(closing.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(events.assert_closed_once(h)["code"], close::CLOSED);
    assert!(events.of(h).iter().all(|e| e["type"] != "pairCode"));
    drop(hole);
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_delivered_after_close() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::Automatic).await;
    server.pair_phone(&id);
    let h = b.connect(&server.id(), &[server.addr()]).unwrap();
    events.wait(h, "opened", Duration::from_secs(10)).await;
    // The reply is on its way when the handle closes.
    b.send(h, HELLO.into()).unwrap();
    b.close(h);
    tokio::time::sleep(Duration::from_millis(800)).await;
    events.assert_closed_once(h);
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_outbound_queue_rejects_send() {
    let (hole, addr) = black_hole();
    let (b, _, _) = bridge(Mode::Automatic).await;
    let h = b.connect(&SecretKey::generate().public().to_string(), &[addr]).unwrap();
    // Nothing drains the queue while the dial hangs.
    for i in 0..OUT_LINES {
        b.send(h, format!("{{\"n\":{i}}}")).unwrap();
    }
    assert_eq!(b.send(h, "{}".into()), Err("busy".into()));
    assert!(b.send(h, "a\nb".into()).is_err());
    drop(hole);
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_app_overflows_and_closes() {
    // A host that floods lines as soon as the phone opens its stream.
    let host_key = SecretKey::generate();
    let host = Endpoint::builder(presets::Minimal).secret_key(host_key.clone()).relay_mode(RelayMode::Disabled).alpns(vec![ALPN.to_vec()]).bind().await.unwrap();
    let port = host.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
    let flood = {
        let host = host.clone();
        tokio::spawn(async move {
            let conn = host.accept().await.unwrap().await.unwrap();
            let (send, _recv) = conn.accept_bi().await.unwrap();
            let mut out = FramedWrite::new(send, LinesCodec::new());
            for i in 0..(IN_EVENTS * 3) {
                if out.send(format!("{{\"n\":{i}}}")).await.is_err() {
                    break;
                }
            }
            let _ = conn.closed().await;
        })
    };
    let events = Events::default();
    let record = events.sink();
    // The app takes 20 ms per event.
    let slow: Sink = Arc::new(move |e: &str| {
        std::thread::sleep(Duration::from_millis(20));
        record(e)
    });
    let b = Bridge::new(tokio::runtime::Handle::current(), None, slow);
    b.set_mode(Zeroizing::new(SecretKey::generate().to_bytes()), Mode::Automatic).await.unwrap();
    let h = b.connect(&host_key.public().to_string(), &[format!("127.0.0.1:{port}")]).unwrap();
    events.wait(h, "opened", Duration::from_secs(10)).await;
    // The host only sees the stream once the phone writes to it.
    b.send(h, "{}".into()).unwrap();
    let closed = events.wait(h, "closed", Duration::from_secs(30)).await;
    assert_eq!(closed["code"], close::OVERFLOW);
    events.assert_closed_once(h);
    b.shutdown().await;
    flood.abort();
    host.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_waits_and_nothing_fires_after() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::Automatic).await;
    server.pair_phone(&id);
    let (hole, addr) = black_hole();
    let live = b.connect(&server.id(), &[server.addr()]).unwrap();
    let hanging = b.connect(&SecretKey::generate().public().to_string(), &[addr]).unwrap();
    events.wait(live, "opened", Duration::from_secs(10)).await;
    b.send(live, HELLO.into()).unwrap();
    b.shutdown().await;
    assert_eq!(b.counts(), (0, 0));
    let n = events.len();
    events.assert_closed_once(live);
    events.assert_closed_once(hanging);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(events.len(), n, "no event after shutdown");
    assert!(b.connect(&server.id(), &[server.addr()]).is_err());
    drop(hole);
}

#[tokio::test(flavor = "multi_thread")]
async fn open_close_cycles_leak_nothing() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::Automatic).await;
    server.pair_phone(&id);
    for i in 0..100 {
        let h = b.connect(&server.id(), &[server.addr()]).unwrap();
        if i % 2 == 0 {
            events.wait(h, "opened", Duration::from_secs(10)).await;
        }
        b.close(h);
    }
    let until = Instant::now() + Duration::from_secs(10);
    while b.counts() != (0, 0) {
        assert!(Instant::now() < until, "still live: {:?}", b.counts());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_host_key_is_rejected() {
    let server = Server::start().await;
    let (b, events, _) = bridge(Mode::Automatic).await;
    // A real invitation from this server, but naming another machine's key.
    let mut invite = server.invite(*server.endpoint.id().as_bytes());
    let real = invite.clone();
    invite.host = *SecretKey::generate().public().as_bytes();
    let h = b.pair(&invite.to_link(), "Phone", now_s()).unwrap();
    let closed = events.wait(h, "closed", Duration::from_secs(30)).await;
    assert!([close::UNREACHABLE, close::WRONG_HOST].contains(&(closed["code"].as_u64().unwrap() as u32)), "{closed}");
    assert!(events.of(h).iter().all(|e| e["type"] != "pairCode"));
    // No proof reached the server: the real invitation is still unclaimed.
    let again = b.pair(&real.to_link(), "Phone", now_s()).unwrap();
    events.wait(again, "pairCode", Duration::from_secs(10)).await;
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_codes_match_and_approval_pairs() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::Automatic).await;
    let invite = server.invite(*server.endpoint.id().as_bytes());
    let h = b.pair(&invite.to_link(), "Test phone", now_s()).unwrap();
    let claim = tokio::time::timeout(Duration::from_secs(10), server.daemon.invites.wait(&invite.inv)).await.unwrap().unwrap();
    let shown = events.wait(h, "pairCode", Duration::from_secs(10)).await;
    assert_eq!(shown["code"], claim.code, "the phone works out the same code");
    assert_eq!(claim.phone_id, id);
    assert_eq!(claim.label, "Test phone");
    let daemon = Arc::clone(&server.daemon);
    tokio::task::spawn_blocking(move || daemon.invites.approve(&invite.inv, &claim.claim_id, &daemon.devices, apex_daemon::devices::now_ms())).await.unwrap().unwrap();
    let done = events.wait(h, "pairDone", Duration::from_secs(10)).await;
    assert_eq!(done["hostEndpointId"], server.id());
    assert_eq!(done["tier"], "chat");
    // Now a paired phone.
    let c = b.connect(&server.id(), &[server.addr()]).unwrap();
    events.wait(c, "opened", Duration::from_secs(10)).await;
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_close_code_reaches_closed() {
    let server = Server::start().await;
    let (b, events, _) = bridge(Mode::Automatic).await;
    // Not paired: the daemon closes with NOT_PAIRED (1).
    let h = b.connect(&server.id(), &[server.addr()]).unwrap();
    let closed = events.wait(h, "closed", Duration::from_secs(10)).await;
    assert_eq!(closed["code"], remote::close::NOT_PAIRED);
    events.assert_closed_once(h);
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn direct_only_connects_without_a_relay() {
    let server = Server::start().await;
    let (b, events, id) = bridge(Mode::DirectOnly).await;
    server.pair_phone(&id);
    let h = b.connect(&server.id(), &[RELAY.into(), server.addr()]).unwrap();
    events.wait(h, "opened", Duration::from_secs(10)).await;
    assert_eq!(events.wait(h, "route", Duration::from_secs(1)).await["route"], "direct");
    b.shutdown().await;
}

#[test]
fn direct_only_drops_relay_hints() {
    let host = SecretKey::generate().public();
    let relay: RelayUrl = RELAY.parse().unwrap();
    let addrs = vec![RELAY.to_string(), "1.2.3.4:5".to_string()];
    let direct = target(host, &addrs, Mode::DirectOnly, Some(&relay)).unwrap();
    assert!(direct.relay_urls().next().is_none(), "no relay in Direct only");
    assert_eq!(direct.ip_addrs().count(), 1);
    let auto = target(host, &addrs, Mode::Automatic, Some(&relay)).unwrap();
    assert_eq!(auto.relay_urls().next(), Some(&relay));
    assert!(target(host, &["https://evil.example/".into()], Mode::Automatic, Some(&relay)).is_err());
    assert!(target(host, &[RELAY.into()], Mode::DirectOnly, Some(&relay)).is_err(), "Direct only needs an IP");
}

#[test]
fn known_answer_matches_apex_pairing() {
    let (proof, code) = pair_material(&[0x11; 32], &[0x22; 16], &[0x33; 32], &[0x44; 32], &[0x55; 32], &[0x66; 32]);
    let hex: String = proof.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "ab3c1a4d4d520bd93c0e5d85389306fb83245e3bc29032d82ec414a2764bd88f");
    assert_eq!(code, "064 257");
}

#[test]
fn modes_parse() {
    assert_eq!(Mode::parse("automatic"), Ok(Mode::Automatic));
    assert_eq!(Mode::parse("direct"), Ok(Mode::DirectOnly));
    assert!(Mode::parse("relay").is_err());
}
