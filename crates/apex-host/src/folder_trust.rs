//! Wrapper around apex-core folder_trust - single copy per Task 6
pub use apex_core::folder_trust::{
    accept, check_full_allowed, is_accepted, is_tainted, list_accepted, mark_tainted, refusal_message, tainted_folders, withdraw,
};
