#![cfg(target_os = "linux")]
use apex_provenance::linux_fuses::verify;
use std::io::Cursor;
fn image() -> Vec<u8> {
    let mut bytes = b"\x7fELF".to_vec();
    bytes.resize(65530, 0);
    bytes.extend(b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x09010001101");
    bytes
}
#[test]
fn fuse_validation_scans_chunk_boundaries_and_rejects_debug_loading_and_ambiguous_wires() {
    let good = image();
    assert!(verify(&mut Cursor::new(&good)).is_ok());
    for (index, value) in [
        (0, b'1'),
        (2, b'1'),
        (3, b'1'),
        (5, b'0'),
        (7, b'1'),
        (0, b'r'),
    ] {
        let mut bad = good.clone();
        bad[65530 + 32 + 2 + index] = value;
        assert!(verify(&mut Cursor::new(bad)).is_err());
    }
    let mut duplicate = good.clone();
    duplicate.extend(&good[65530..]);
    assert!(verify(&mut Cursor::new(duplicate)).is_err());
    assert!(verify(&mut Cursor::new(b"#!/bin/sh\n")).is_err());
    assert!(verify(&mut Cursor::new(b"\x7fELFno fuse wire")).is_err());
    assert!(verify(&mut Cursor::new(&good[..good.len() - 1])).is_err());
}
