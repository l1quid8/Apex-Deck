//! The jail's only way out: `CONNECT` to port 443, on addresses checked here.
//! Tests drive it through `Net`, so no test touches the real network to dial.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream};
use tokio::time::timeout;

#[async_trait::async_trait]
pub trait Net: Send + Sync + 'static {
    type Upstream: AsyncRead + AsyncWrite + Unpin + Send;
    async fn lookup(&self, host: &str) -> io::Result<Vec<IpAddr>>;
    fn own_addrs(&self) -> io::Result<Vec<IpAddr>>;
    async fn dial(&self, target: SocketAddr) -> io::Result<Self::Upstream>;
}

const MAX_HEAD: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const PORT: u16 = 443;

/// The real network. `observed` is the public address iroh sees for this machine.
#[derive(Default)]
pub struct Internet { pub observed: Mutex<Vec<IpAddr>> }

#[async_trait::async_trait]
impl Net for Internet {
    type Upstream = TcpStream;

    async fn lookup(&self, host: &str) -> io::Result<Vec<IpAddr>> {
        Ok(lookup_host((host, PORT)).await?.map(|found| found.ip()).collect())
    }

    fn own_addrs(&self) -> io::Result<Vec<IpAddr>> {
        let mut own = interface_addrs()?;
        own.extend(self.observed.lock().unwrap_or_else(|e| e.into_inner()).iter());
        Ok(own)
    }

    async fn dial(&self, target: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(target).await
    }
}

fn interface_addrs() -> io::Result<Vec<IpAddr>> {
    let mut list = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list`, which is walked once and then freed.
    if unsafe { libc::getifaddrs(&mut list) } != 0 { return Err(io::Error::last_os_error()); }
    let mut out = Vec::new();
    let mut next = list;
    while !next.is_null() {
        // SAFETY: `next` is a live entry; ifa_addr points at a sockaddr of the family it names.
        unsafe {
            let addr = (*next).ifa_addr;
            if !addr.is_null() {
                match (*addr).sa_family as i32 {
                    libc::AF_INET => {
                        let v4 = addr as *const libc::sockaddr_in;
                        out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be((*v4).sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let v6 = addr as *const libc::sockaddr_in6;
                        out.push(IpAddr::V6(Ipv6Addr::from((*v6).sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            next = (*next).ifa_next;
        }
    }
    // SAFETY: `list` came from getifaddrs and isn't used after this.
    unsafe { libc::freeifaddrs(list) };
    Ok(out)
}

/// Unwraps the forms that carry an IPv4 address, so each is judged as that address.
fn plain(ip: IpAddr) -> IpAddr {
    let IpAddr::V6(v6) = ip else { return ip };
    let s = v6.segments();
    let v4 = |high: u16, low: u16| IpAddr::V4(Ipv4Addr::from((high as u32) << 16 | low as u32));
    match s {
        // IPv4-mapped, IPv4-compatible and IPv4-translated.
        [0, 0, 0, 0, 0, 0xffff, high, low] | [0, 0, 0, 0, 0xffff, 0, high, low] => v4(high, low),
        [0, 0, 0, 0, 0, 0, high, low] if high != 0 => v4(high, low),
        // NAT64's well-known prefix.
        [0x64, 0xff9b, 0, 0, 0, 0, high, low] => v4(high, low),
        // 6to4.
        [0x2002, high, low, ..] => v4(high, low),
        _ => ip,
    }
}

fn v4_refused(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    matches!(
        (a, b, c),
        (0 | 10 | 127, _, _)
            | (100, 64..=127, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0) | (192, 0, 2) | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100) | (203, 0, 113)
            | (224..=255, _, _)
    ) || (a, b, c, d) == (168, 63, 129, 16) // Azure's metadata and agent address.
}

/// Only global unicast passes; every other IPv6 range is refused by default.
fn v6_refused(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    s[0] & 0xe000 != 0x2000
        || (s[0] == 0x2001 && s[1] < 0x0200) // Teredo and other special blocks.
        || (s[0] == 0x2001 && s[1] == 0x0db8)
        || (s[0] == 0x3fff && s[1] < 0x1000)
        || (s[4] & 0xfdff == 0 && s[5] == 0x5efe) // ISATAP carries an IPv4 address.
}

pub fn refused(ip: IpAddr, own: &[IpAddr]) -> bool {
    let ip = plain(ip);
    own.iter().any(|mine| plain(*mine) == ip)
        || match ip { IpAddr::V4(v4) => v4_refused(v4), IpAddr::V6(v6) => v6_refused(v6) }
}

fn target(head: &[u8]) -> Option<&str> {
    let line = head.split(|byte| *byte == b'\r').next()?;
    let mut parts = std::str::from_utf8(line).ok()?.split(' ');
    let (method, authority, version) = (parts.next()?, parts.next()?, parts.next()?);
    if method != "CONNECT" || !version.starts_with("HTTP/1.") || parts.next().is_some() { return None; }
    let host = authority.strip_suffix(":443")?;
    if let Some(inner) = host.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        inner.parse::<Ipv6Addr>().ok()?;
        return Some(inner);
    }
    let name = !host.is_empty() && host.len() <= 253
        && host.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'));
    name.then_some(host)
}

/// Returns where the head ends, or `None` if it's too long, too slow or cut short.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S, seen: &mut Vec<u8>) -> Option<usize> {
    let mut chunk = [0u8; 1024];
    timeout(HEAD_TIMEOUT, async {
        loop {
            if let Some(end) = seen.windows(4).position(|w| w == b"\r\n\r\n") { return Some(end + 4).filter(|end| *end <= MAX_HEAD); }
            if seen.len() > MAX_HEAD { return None; }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(read) => seen.extend_from_slice(&chunk[..read]),
            }
        }
    }).await.ok().flatten()
}

async fn answer<S: AsyncWrite + Unpin>(stream: &mut S, status: &str) {
    let reply = format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

const REFUSED: &str = "403 Apex Deck refused this address";
const FAILED: &str = "502 Apex Deck could not connect";

/// Handles one connection from the jail, start to finish.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send, N: Net>(mut stream: S, net: &N) {
    let mut seen = Vec::new();
    let Some(end) = read_head(&mut stream, &mut seen).await else { return answer(&mut stream, REFUSED).await };
    let Some(host) = target(&seen[..end]) else { return answer(&mut stream, REFUSED).await };
    // One lookup, so what's dialled is what was checked.
    let answers = match timeout(LOOKUP_TIMEOUT, net.lookup(host)).await {
        Ok(Ok(answers)) => answers,
        _ => return answer(&mut stream, FAILED).await,
    };
    let Ok(own) = net.own_addrs() else { return answer(&mut stream, REFUSED).await };
    let mut checked = answers.into_iter().filter(|ip| !refused(*ip, &own)).peekable();
    if checked.peek().is_none() { return answer(&mut stream, REFUSED).await; }
    let mut upstream = None;
    for ip in checked {
        if let Ok(Ok(open)) = timeout(DIAL_TIMEOUT, net.dial(SocketAddr::new(ip, PORT))).await {
            upstream = Some(open);
            break;
        }
    }
    let Some(mut upstream) = upstream else { return answer(&mut stream, FAILED).await };
    if stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.is_err() { return; }
    if upstream.write_all(&seen[end..]).await.is_err() { return; }
    let _ = copy_bidirectional(&mut stream, &mut upstream).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, DuplexStream};

    fn ip(text: &str) -> IpAddr { text.parse().unwrap() }

    #[test]
    fn every_refused_range_is_refused_in_every_encoding() {
        for v4 in [
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.100.100.200", "100.127.255.255",
            "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255",
            "192.0.0.192", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
            "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
            "168.63.129.16",
        ] {
            let parts: Vec<u8> = v4.split('.').map(|p| p.parse().unwrap()).collect();
            let (high, low) = (u16::from_be_bytes([parts[0], parts[1]]), u16::from_be_bytes([parts[2], parts[3]]));
            assert!(refused(ip(v4), &[]), "{v4}");
            for form in [
                format!("::ffff:{v4}"), format!("::{v4}"), format!("::ffff:0:{v4}"),
                format!("64:ff9b::{high:x}:{low:x}"), format!("2002:{high:x}:{low:x}::1"),
            ] {
                assert!(refused(ip(&form), &[]), "{form}");
            }
        }
        for v6 in [
            "::", "::1", "100::1", "64:ff9b:1::1", "2001::1", "2001:0:4136:e378::1", "2001:2::1",
            "2001:db8::1", "3fff::1", "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1",
            "2a01:4f8::5efe:7f00:1", "2a01:4f8::200:5efe:7f00:1",
        ] {
            assert!(refused(ip(v6), &[]), "{v6}");
        }
    }

    #[test]
    fn outside_addresses_pass_in_every_encoding() {
        for good in [
            "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1",
            "198.17.0.1", "198.20.0.1", "192.0.1.1", "::ffff:8.8.8.8", "64:ff9b::808:808",
            "2002:808:808::1", "2606:4700::1111", "2a00:1450:4001::1",
        ] {
            assert!(!refused(ip(good), &[]), "{good}");
        }
    }

    #[test]
    fn own_addresses_are_refused_in_every_encoding() {
        let own = [ip("8.8.8.8"), ip("2a01:4f8::1"), ip("::ffff:9.9.9.9")];
        for text in ["8.8.8.8", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2a01:4f8::1", "9.9.9.9"] {
            assert!(refused(ip(text), &own), "{text}");
        }
        assert!(!refused(ip("8.8.4.4"), &own));
        assert!(!refused(ip("2a01:4f8::2"), &own));
    }

    struct Fake {
        answers: Mutex<Vec<io::Result<Vec<IpAddr>>>>,
        own: Mutex<Vec<io::Result<Vec<IpAddr>>>>,
        dead: Vec<IpAddr>,
        keep_far: bool,
        lookups: Mutex<Vec<String>>,
        dialled: Mutex<Vec<SocketAddr>>,
        far: Mutex<Vec<DuplexStream>>,
    }

    impl Fake {
        fn new(answers: Vec<Vec<&str>>) -> Self {
            Fake {
                answers: Mutex::new(answers.into_iter().rev().map(|a| Ok(a.into_iter().map(ip).collect())).collect()),
                own: Mutex::new(Vec::new()), dead: Vec::new(), keep_far: false, lookups: Mutex::default(),
                dialled: Mutex::default(), far: Mutex::default(),
            }
        }
        fn dialled(&self) -> Vec<SocketAddr> { self.dialled.lock().unwrap().clone() }
    }

    #[async_trait::async_trait]
    impl Net for Fake {
        type Upstream = DuplexStream;
        async fn lookup(&self, host: &str) -> io::Result<Vec<IpAddr>> {
            self.lookups.lock().unwrap().push(host.into());
            self.answers.lock().unwrap().pop().unwrap_or_else(|| Err(io::ErrorKind::NotFound.into()))
        }
        fn own_addrs(&self) -> io::Result<Vec<IpAddr>> {
            self.own.lock().unwrap().pop().unwrap_or(Ok(Vec::new()))
        }
        async fn dial(&self, target: SocketAddr) -> io::Result<DuplexStream> {
            self.dialled.lock().unwrap().push(target);
            if self.dead.contains(&target.ip()) { return Err(io::ErrorKind::ConnectionRefused.into()); }
            let (near, far) = duplex(4096);
            if self.keep_far { self.far.lock().unwrap().push(far); }
            Ok(near)
        }
    }

    /// Sends a request to a proxy that has ended and returns everything it replied.
    async fn ask(net: &Fake, request: &[u8]) -> String {
        let (mut bot, jail) = duplex(70_000);
        bot.write_all(request).await.unwrap();
        bot.shutdown().await.unwrap();
        serve(jail, net).await;
        let mut reply = String::new();
        bot.read_to_string(&mut reply).await.unwrap();
        reply
    }

    const OK: &[u8] = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";

    #[tokio::test]
    async fn only_connect_to_443_is_taken() {
        for bad in [
            &b"GET http://example.com/ HTTP/1.1\r\n\r\n"[..],
            b"CONNECT example.com:80 HTTP/1.1\r\n\r\n",
            b"CONNECT example.com:8443 HTTP/1.1\r\n\r\n",
            b"CONNECT example.com HTTP/1.1\r\n\r\n",
            b"CONNECT user@example.com:443 HTTP/1.1\r\n\r\n",
            b"CONNECT exa mple.com:443 HTTP/1.1\r\n\r\n",
            b"CONNECT ::1:443 HTTP/1.1\r\n\r\n",
            b"CONNECT [fe80::1%eth0]:443 HTTP/1.1\r\n\r\n",
            b"connect example.com:443 HTTP/1.1\r\n\r\n",
        ] {
            let net = Fake::new(vec![vec!["1.1.1.1"]]);
            let reply = ask(&net, bad).await;
            assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
            assert!(net.lookups.lock().unwrap().is_empty(), "{bad:?}");
            assert!(net.dialled().is_empty());
        }
    }

    #[tokio::test]
    async fn a_name_with_mixed_answers_dials_only_checked_ones() {
        let net = Fake::new(vec![vec!["127.0.0.1", "169.254.169.254", "1.1.1.1", "10.0.0.1"]]);
        let reply = ask(&net, OK).await;
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert_eq!(net.dialled(), vec![SocketAddr::new(ip("1.1.1.1"), 443)]);
    }

    #[tokio::test]
    async fn a_dead_address_falls_through_to_the_next_checked_one() {
        let mut net = Fake::new(vec![vec!["1.1.1.1", "10.0.0.1", "8.8.8.8"]]);
        net.dead = vec![ip("1.1.1.1")];
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 200"));
        assert_eq!(net.dialled(), vec![SocketAddr::new(ip("1.1.1.1"), 443), SocketAddr::new(ip("8.8.8.8"), 443)]);
    }

    #[tokio::test]
    async fn a_name_changing_between_lookups_is_looked_up_once() {
        let net = Fake::new(vec![vec!["1.1.1.1"], vec!["127.0.0.1"]]);
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 200"));
        assert_eq!(net.lookups.lock().unwrap().len(), 1);
        assert_eq!(net.dialled(), vec![SocketAddr::new(ip("1.1.1.1"), 443)]);
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 403"));
        assert_eq!(net.dialled().len(), 1);
    }

    #[tokio::test]
    async fn own_addresses_are_read_for_each_connection() {
        let net = Fake::new(vec![vec!["1.1.1.1"], vec!["1.1.1.1"]]);
        *net.own.lock().unwrap() = vec![Ok(vec![ip("1.1.1.1")]), Ok(Vec::new())];
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 200"));
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 403"));
    }

    #[tokio::test]
    async fn unreadable_own_addresses_refuse_the_connection() {
        let net = Fake::new(vec![vec!["1.1.1.1"]]);
        *net.own.lock().unwrap() = vec![Err(io::ErrorKind::Other.into())];
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 403"));
        assert!(net.dialled().is_empty());
    }

    #[tokio::test]
    async fn failures_answer_without_dialling_refused_addresses() {
        assert!(ask(&Fake::new(vec![]), OK).await.starts_with("HTTP/1.1 502"));
        let net = Fake::new(vec![vec![]]);
        assert!(ask(&net, OK).await.starts_with("HTTP/1.1 403"));
    }

    #[tokio::test]
    async fn an_oversized_head_is_refused() {
        let mut big = b"CONNECT example.com:443 HTTP/1.1\r\nX: ".to_vec();
        big.extend(vec![b'a'; 20_000]);
        big.extend(b"\r\n\r\n");
        let net = Fake::new(vec![vec!["1.1.1.1"]]);
        assert!(ask(&net, &big).await.starts_with("HTTP/1.1 403"));
        assert!(net.dialled().is_empty());
    }

    #[tokio::test]
    async fn a_head_is_limited_to_exactly_its_maximum() {
        let sized = |size: usize| {
            let mut head = b"CONNECT example.com:443 HTTP/1.1\r\nX: ".to_vec();
            head.extend(vec![b'a'; size - head.len() - 4]);
            head.extend(b"\r\n\r\n");
            head
        };
        let net = Fake::new(vec![vec!["1.1.1.1"]]);
        assert!(ask(&net, &sized(MAX_HEAD)).await.starts_with("HTTP/1.1 200"));
        let net = Fake::new(vec![vec!["1.1.1.1"]]);
        assert!(ask(&net, &sized(MAX_HEAD + 1)).await.starts_with("HTTP/1.1 403"));
        assert!(net.dialled().is_empty());
    }

    #[tokio::test]
    async fn bytes_pass_both_ways_including_any_sent_with_the_head() {
        let mut net = Fake::new(vec![vec!["1.1.1.1"]]);
        net.keep_far = true;
        let net = std::sync::Arc::new(net);
        let (mut bot, jail) = duplex(4096);
        let running = { let net = net.clone(); tokio::spawn(async move { serve(jail, &*net).await }) };
        bot.write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\nearly").await.unwrap();
        let mut head = [0u8; 39];
        bot.read_exact(&mut head).await.unwrap();
        assert!(head.starts_with(b"HTTP/1.1 200"));
        let mut far = loop {
            if let Some(far) = net.far.lock().unwrap().pop() { break far; }
            tokio::task::yield_now().await;
        };
        let mut seen = [0u8; 5];
        far.read_exact(&mut seen).await.unwrap();
        assert_eq!(&seen, b"early");
        far.write_all(b"reply").await.unwrap();
        bot.read_exact(&mut seen).await.unwrap();
        assert_eq!(&seen, b"reply");
        drop((far, bot));
        running.await.unwrap();
    }

    #[tokio::test]
    async fn the_real_lookup_cannot_reach_this_machine_by_any_spelling() {
        let net = Internet::default();
        for host in ["localhost", "127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "0", "[::1]", "[::ffff:127.0.0.1]"] {
            let (mut bot, jail) = duplex(4096);
            bot.write_all(format!("CONNECT {host}:443 HTTP/1.1\r\n\r\n").as_bytes()).await.unwrap();
            serve(jail, &net).await;
            let mut reply = [0u8; 12];
            bot.read_exact(&mut reply).await.unwrap();
            assert!(!reply.ends_with(b"200"), "{host}");
        }
    }

    #[test]
    fn the_real_own_addresses_include_loopback_and_the_observed_one() {
        let net = Internet::default();
        net.observed.lock().unwrap().push(ip("8.8.8.8"));
        let own = net.own_addrs().unwrap();
        assert!(own.iter().any(|a| a.is_loopback()), "{own:?}");
        assert!(own.contains(&ip("8.8.8.8")));
    }
}
