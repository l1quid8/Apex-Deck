use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub struct Transcript<'a> {
    pub invitation: &'a [u8; 16],
    pub challenge: &'a [u8; 32],
    pub host: &'a [u8; 32],
    pub phone: &'a [u8; 32],
    pub ekm: &'a [u8; 32],
}

const PREFIX: &[u8] = b"apex-deck pair v1\0";
const CODE_PREFIX: &[u8] = b"apex-deck pair code v1\0";

fn transcript(t: &Transcript) -> Vec<u8> {
    let mut v = Vec::with_capacity(PREFIX.len() + 16 + 32 * 4);
    v.extend_from_slice(PREFIX);
    v.extend_from_slice(t.invitation);
    v.extend_from_slice(t.challenge);
    v.extend_from_slice(t.host);
    v.extend_from_slice(t.phone);
    v.extend_from_slice(t.ekm);
    v
}

fn mac(secret: &[u8; 32], parts: &[&[u8]]) -> HmacSha256 {
    let mut m = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    for p in parts {
        m.update(p);
    }
    m
}

pub fn proof(secret: &[u8; 32], t: &Transcript) -> [u8; 32] {
    mac(secret, &[&transcript(t)]).finalize().into_bytes().into()
}

/// Constant-time check.
pub fn verify(secret: &[u8; 32], t: &Transcript, proof: &[u8]) -> bool {
    mac(secret, &[&transcript(t)]).verify_slice(proof).is_ok()
}

/// Six digits both screens show, "NNN NNN".
pub fn code(secret: &[u8; 32], t: &Transcript) -> String {
    let d = mac(secret, &[CODE_PREFIX, &transcript(t)]).finalize().into_bytes();
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INV: [u8; 16] = [0x22; 16];
    const CH: [u8; 32] = [0x33; 32];
    const HOST: [u8; 32] = [0x44; 32];
    const PHONE: [u8; 32] = [0x55; 32];
    const EKM: [u8; 32] = [0x66; 32];
    const SECRET: [u8; 32] = [0x11; 32];

    fn t<'a>() -> Transcript<'a> {
        Transcript { invitation: &INV, challenge: &CH, host: &HOST, phone: &PHONE, ekm: &EKM }
    }

    #[test]
    fn proof_verifies() {
        let p = proof(&SECRET, &t());
        assert!(verify(&SECRET, &t(), &p));
        assert!(!verify(&[0x12; 32], &t(), &p));
        assert!(!verify(&SECRET, &t(), &p[..31]));
    }

    #[test]
    fn each_field_matters() {
        let p = proof(&SECRET, &t());
        let (i2, c2, h2, p2, e2) = ([0u8; 16], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32]);
        let cases = [
            Transcript { invitation: &i2, ..t() },
            Transcript { challenge: &c2, ..t() },
            Transcript { host: &h2, ..t() },
            Transcript { phone: &p2, ..t() },
            Transcript { ekm: &e2, ..t() },
        ];
        for c in &cases {
            assert!(!verify(&SECRET, c, &p));
        }
    }

    #[test]
    fn code_shape_and_phone_sensitivity() {
        let c = code(&SECRET, &t());
        assert_eq!(c.len(), 7);
        let b = c.as_bytes();
        assert!(b[3] == b' ' && b.iter().enumerate().all(|(i, x)| i == 3 || x.is_ascii_digit()));
        let other = [0x56; 32];
        assert_ne!(c, code(&SECRET, &Transcript { phone: &other, ..t() }));
    }

    #[test]
    fn known_answer() {
        let hex: String = proof(&SECRET, &t()).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "ab3c1a4d4d520bd93c0e5d85389306fb83245e3bc29032d82ec414a2764bd88f");
        assert_eq!(code(&SECRET, &t()), "064 257");
    }
}
