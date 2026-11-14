#[test]
#[cfg(target_os = "linux")]
fn linux_uses_the_system_service_authority_paths() {
    assert_eq!(apex_provenance::ROOT, "/var/lib/apex-deck-provenance");
    assert_eq!(apex_provenance::SOCKET, "/run/apex-deck/provenance.sock");
}

#[test]
#[cfg(target_os = "macos")]
fn macos_keeps_its_existing_authority_paths() {
    assert_eq!(apex_provenance::ROOT, "/Library/Application Support/Apex Deck Provenance");
    assert_eq!(apex_provenance::SOCKET, "/var/run/dev.apexdeck.provenance.sock");
}

#[test]
#[cfg(target_os = "linux")]
#[ignore = "requires root on a disposable Linux runner"]
fn uninstalled_broker_stops_before_initializing_authority() {
    assert_eq!(unsafe { libc::geteuid() }, 0);
    let root = std::path::Path::new(apex_provenance::ROOT);
    assert!(!root.exists(), "requires a fresh disposable runner with no authority");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_apex-provenance"))
        .output().unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("Protected provenance service unavailable"), "{error}");
    assert!(!root.exists(), "uninstalled startup created authority state");
    assert!(!std::path::Path::new(apex_provenance::SOCKET).exists());
}
