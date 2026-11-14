fn main() {
    println!("cargo:rerun-if-env-changed=APEX_LINUX_EVALUATION_PUBLIC_KEY");
    if std::env::var_os("CARGO_FEATURE_LINUX_EVALUATION_VERIFIER").is_some() {
        let key = std::env::var("APEX_LINUX_EVALUATION_PUBLIC_KEY")
            .expect("Evaluation verifier requires an independently provisioned build-time public key");
        assert!(key.len() == 44 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)), "Invalid evaluation public key encoding");
        println!("cargo:rustc-env=APEX_LINUX_EVALUATION_TRUST_ROOT={key}");
    }
    println!("cargo:rerun-if-changed=native/peer.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/peer.m")
            .flag("-fobjc-arc")
            .compile("provenance_peer");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=bsm");
    }
}
