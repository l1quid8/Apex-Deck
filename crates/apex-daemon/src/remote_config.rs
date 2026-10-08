//! `remote.json` in the data folder: the UDP port remote access keeps, and
//! the addresses the user advertises for it (`"advertise"`), such as a DDNS
//! name with a forwarded port. Advertised addresses go into the pairing QR
//! and into a device's `hello`; they are hints for the phone to dial, never
//! a reason to trust anything.
//!
//! Not behind the `remote` feature, so the setting can be read and changed
//! whether or not this build serves remote access.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::files;

/// The file, inside the data folder.
pub const FILE: &str = "remote.json";

/// The most addresses one may advertise.
pub const MAX_ADVERTISE: usize = 8;

/// Read-modify-write of the file happens one at a time in this process.
static WRITING: Mutex<()> = Mutex::new(());

/// What's saved: `{"port": n, "advertise": [...]}`, either may be missing.
fn read(data: &Path) -> Map<String, Value> {
    match std::fs::read_to_string(data.join(FILE)).ok().and_then(|text| serde_json::from_str(&text).ok()) {
        Some(Value::Object(fields)) => fields,
        _ => Map::new(),
    }
}

fn write(data: &Path, fields: Map<String, Value>) -> Result<(), String> {
    files::write_private(&data.join(FILE), &format!("{}\n", Value::Object(fields)))
}

/// The UDP port saved at first start, if any.
pub fn port(data: &Path) -> Option<u16> {
    read(data).get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0)
}

/// Save the port remote access bound, keeping what else the file holds.
pub fn save_port(data: &Path, port: u16) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut fields = read(data);
    fields.insert("port".into(), json!(port));
    write(data, fields)
}

/// The advertised addresses, as saved. Anything in the file that doesn't
/// pass `check_addr` is left out.
pub fn advertised(data: &Path) -> Vec<String> {
    let saved = read(data).get("advertise").and_then(Value::as_array).cloned().unwrap_or_default();
    saved.iter().filter_map(Value::as_str).filter_map(|a| check_addr(a).ok()).take(MAX_ADVERTISE).collect()
}

/// Replace the advertised addresses (an empty list clears them). Every
/// address must pass `check_addr`, or nothing changes. Duplicates are
/// dropped. Returns the list as saved.
pub fn set_advertised(data: &Path, addrs: &[String]) -> Result<Vec<String>, String> {
    let list = check_all(addrs)?;
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut fields = read(data);
    if list.is_empty() {
        fields.remove("advertise");
    } else {
        fields.insert("advertise".into(), json!(list));
    }
    write(data, fields)?;
    Ok(list)
}

/// `addrs` checked with `check_addr`, without duplicates, at most
/// `MAX_ADVERTISE` of them.
pub fn check_all(addrs: &[String]) -> Result<Vec<String>, String> {
    let mut list: Vec<String> = Vec::new();
    for addr in addrs {
        let addr = check_addr(addr)?;
        if !list.contains(&addr) {
            list.push(addr);
        }
    }
    if list.len() > MAX_ADVERTISE {
        return Err(format!("advertise at most {MAX_ADVERTISE} addresses"));
    }
    Ok(list)
}

/// An address a phone may dial: `host:port`, `a.b.c.d:port` or `[v6]:port`,
/// with a port from 1 to 65535. A host name is letters, digits and hyphens
/// in dot-separated labels, and doesn't end in an all-digit label (so
/// `999.1.1.1` is refused rather than taken for a name). Returned trimmed,
/// with a host name in lower case.
pub fn check_addr(text: &str) -> Result<String, String> {
    let text = text.trim();
    let refuse = || format!("{text:?} is not an address to advertise; say host:port, like myhome.example.net:41641 or [2001:db8::1]:41641");
    if let Ok(addr) = text.parse::<SocketAddr>() {
        if addr.port() == 0 {
            return Err(refuse());
        }
        return Ok(addr.to_string());
    }
    let (host, port) = text.rsplit_once(':').ok_or_else(refuse)?;
    let port: u16 = port.parse().ok().filter(|p| *p != 0 && port.bytes().all(|b| b.is_ascii_digit())).ok_or_else(refuse)?;
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let labels: Vec<&str> = host.split('.').collect();
    let last_is_number = labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()));
    if host.is_empty() || host.len() > 253 || !labels.iter().all(|l| label_ok(l)) || last_is_number {
        return Err(refuse());
    }
    Ok(format!("{host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_and_port_and_bracketed_v6_are_accepted() {
        assert_eq!(check_addr("myhome.ddns.net:41641"), Ok("myhome.ddns.net:41641".into()));
        assert_eq!(check_addr(" MyHome.DDNS.net:41641 "), Ok("myhome.ddns.net:41641".into()));
        assert_eq!(check_addr("studio:1"), Ok("studio:1".into()));
        assert_eq!(check_addr("203.0.113.7:41641"), Ok("203.0.113.7:41641".into()));
        assert_eq!(check_addr("[2001:db8::1]:65535"), Ok("[2001:db8::1]:65535".into()));
    }

    #[test]
    fn nonsense_is_refused() {
        for bad in ["nonsense", "", ":41641", "host:", "host:0", "host:65536", "host:-1", "host:+80", "2001:db8::1", "[2001:db8::1]", "[nope]:80", "999.1.1.1:80", "a..b:80", "-a.b:80", "a_b.c:80", "http://host:80", "host:80/path", "host name:80"] {
            assert!(check_addr(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(check_addr("nonsense").unwrap_err().contains("host:port"));
    }

    #[test]
    fn advertised_addresses_are_saved_beside_the_port() {
        let data = crate::devices::tests::folder();
        save_port(&data.0, 41641).unwrap();
        assert_eq!(set_advertised(&data.0, &["b.example:1".into(), "[::1]:2".into(), "b.example:1".into()]), Ok(vec!["b.example:1".into(), "[::1]:2".into()]));
        assert_eq!((port(&data.0), advertised(&data.0)), (Some(41641), vec!["b.example:1".to_string(), "[::1]:2".to_string()]));
        // Starting again rewrites the port and keeps the addresses.
        save_port(&data.0, 5000).unwrap();
        assert_eq!((port(&data.0), advertised(&data.0).len()), (Some(5000), 2));
        // One bad address changes nothing.
        assert!(set_advertised(&data.0, &["ok.example:1".into(), "nonsense".into()]).is_err());
        assert_eq!(advertised(&data.0).len(), 2);
        assert_eq!(set_advertised(&data.0, &[]), Ok(vec![]));
        assert_eq!((port(&data.0), advertised(&data.0)), (Some(5000), Vec::<String>::new()));
        let too_many: Vec<String> = (1..=MAX_ADVERTISE as u16 + 1).map(|p| format!("h.example:{p}")).collect();
        assert!(set_advertised(&data.0, &too_many).is_err());
    }
}
