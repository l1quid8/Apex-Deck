use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::{Deserialize, Serialize};

pub const RELAY: &str = "https://relay.apex-terminal.xyz/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub v: u32,
    pub host: [u8; 32],
    pub name: String,
    pub relay: String,
    pub addrs: Vec<String>,
    pub inv: [u8; 16],
    pub secret: [u8; 32],
    pub exp: u64,
}

const PREFIX: &str = "apexdeck://pair?p=";
const SKEW_S: u64 = 120;

#[derive(Serialize, Deserialize)]
struct Wire {
    v: u32,
    host: String,
    name: String,
    relay: String,
    addrs: Vec<String>,
    inv: String,
    secret: String,
    exp: u64,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("host must be 64 lowercase hex characters".into());
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn unb64<const N: usize>(field: &str, s: &str) -> Result<[u8; N], String> {
    let v = B64.decode(s).map_err(|_| format!("{field} is not valid base64"))?;
    v.try_into().map_err(|_| format!("{field} has the wrong length"))
}

impl Invite {
    pub fn to_link(&self) -> String {
        let w = Wire {
            v: self.v,
            host: hex(&self.host),
            name: self.name.clone(),
            relay: self.relay.clone(),
            addrs: self.addrs.clone(),
            inv: B64.encode(self.inv),
            secret: B64.encode(self.secret),
            exp: self.exp,
        };
        let json = serde_json::to_vec(&w).expect("wire struct serializes");
        format!("{PREFIX}{}", B64.encode(json))
    }

    pub fn parse_link(link: &str, now_s: u64) -> Result<Invite, String> {
        let p = link.trim().strip_prefix(PREFIX).ok_or("not an Apex Deck pairing link")?;
        let raw = B64.decode(p).map_err(|_| "pairing link is not valid base64")?;
        let w: Wire = serde_json::from_slice(&raw).map_err(|e| format!("pairing link is malformed: {e}"))?;
        if w.v != 1 {
            return Err(format!("unsupported pairing link version {}", w.v));
        }
        if w.relay != RELAY {
            return Err("pairing link names an unknown relay".into());
        }
        if now_s > w.exp.saturating_add(SKEW_S) {
            return Err("pairing link has expired".into());
        }
        Ok(Invite {
            v: w.v,
            host: unhex32(&w.host)?,
            name: w.name,
            relay: w.relay,
            addrs: w.addrs,
            inv: unb64("inv", &w.inv)?,
            secret: unb64("secret", &w.secret)?,
            exp: w.exp,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invite() -> Invite {
        Invite {
            v: 1,
            host: [0xab; 32],
            name: "Tyler's Mac Studio".into(),
            relay: RELAY.into(),
            addrs: vec!["192.168.50.14:41641".into()],
            inv: [7; 16],
            secret: [9; 32],
            exp: 1_000_000,
        }
    }

    fn link_from(json: &str) -> String {
        format!("apexdeck://pair?p={}", B64.encode(json))
    }

    fn json_with(f: impl FnOnce(&mut serde_json::Value)) -> String {
        let l = invite().to_link();
        let raw = B64.decode(l.strip_prefix("apexdeck://pair?p=").unwrap()).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        f(&mut v);
        link_from(&v.to_string())
    }

    #[test]
    fn round_trip() {
        let i = invite();
        let l = i.to_link();
        assert!(l.starts_with("apexdeck://pair?p="));
        assert_eq!(Invite::parse_link(&l, 1_000_000).unwrap(), i);
        let raw = B64.decode(l.strip_prefix("apexdeck://pair?p=").unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(v["host"], "ab".repeat(32));
    }

    #[test]
    fn rejects_bad_version() {
        assert!(Invite::parse_link(&json_with(|v| v["v"] = 2.into()), 0).is_err());
    }

    #[test]
    fn rejects_other_relay() {
        let l = json_with(|v| v["relay"] = "https://evil.example/".into());
        assert!(Invite::parse_link(&l, 0).is_err());
    }

    #[test]
    fn expiry_with_skew() {
        let l = invite().to_link();
        assert!(Invite::parse_link(&l, 1_000_120).is_ok());
        assert!(Invite::parse_link(&l, 1_000_121).is_err());
    }

    #[test]
    fn rejects_bad_base64_and_prefix() {
        assert!(Invite::parse_link("apexdeck://pair?p=!!!", 0).is_err());
        assert!(Invite::parse_link("https://pair?p=abc", 0).is_err());
        assert!(Invite::parse_link("apexdeck://pair", 0).is_err());
    }

    #[test]
    fn rejects_bad_host_and_lengths() {
        assert!(Invite::parse_link(&json_with(|v| v["host"] = "abcd".into()), 0).is_err());
        assert!(Invite::parse_link(&json_with(|v| v["host"] = "zz".repeat(32).into()), 0).is_err());
        assert!(Invite::parse_link(&json_with(|v| v["inv"] = B64.encode([1u8; 15]).into()), 0).is_err());
        assert!(Invite::parse_link(&json_with(|v| v["secret"] = B64.encode([1u8; 31]).into()), 0).is_err());
    }
}
