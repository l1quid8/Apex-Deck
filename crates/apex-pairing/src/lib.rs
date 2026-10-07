//! Pairing proof, code and link format. Pure functions, no networking.
mod link;
mod proof;

pub use link::{Invite, RELAY};
pub use proof::{code, proof, verify, Transcript};
