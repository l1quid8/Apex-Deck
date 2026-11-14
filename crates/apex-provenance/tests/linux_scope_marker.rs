#![cfg(target_os="linux")]
use apex_provenance::linux_registration::protected_scope;
#[test]
fn a_nonabsolute_storage_path_cannot_choose_plain_authority_mode() {
    assert!(protected_scope(std::path::Path::new("relative/data")).is_err());
}
