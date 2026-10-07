//! QR pairing (milestone 3): the proof, code and link format from
//! `apex_pairing`, and the daemon's invitations.

pub use apex_pairing::*;

pub mod invites;

/// Close codes for a pairing connection (`apex-deck/pair/1`).
pub mod close {
    pub const PAIR_UNKNOWN: u32 = 10;
    pub const PAIR_EXPIRED: u32 = 11;
    pub const PAIR_USED: u32 = 12;
    pub const PAIR_BAD_PROOF: u32 = 13;
    pub const PAIR_DENIED: u32 = 14;
}
