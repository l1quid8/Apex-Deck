fn main() {
    println!("cargo:rerun-if-env-changed=APEX_CHANNEL");
    let channel = std::env::var_os("APEX_CHANNEL").unwrap_or_else(|| "stable".into());
    let channel = channel.to_str().expect("APEX_CHANNEL must be stable or nightly");
    assert!(matches!(channel, "stable" | "nightly"), "Invalid APEX_CHANNEL");
    println!("cargo:rerun-if-changed=../../desktop/channels.json");
    let table: serde_json::Value = serde_json::from_str(include_str!("../../desktop/channels.json")).unwrap();
    let mut source = format!("pub const NIGHTLY: bool = {};\n", channel == "nightly");
    for (name, value) in table[channel].as_object().unwrap() {
        source.push_str(&format!("pub const {name}: &str = {:?};\n", value.as_str().unwrap()));
    }
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(out.join("channel.rs"), source).unwrap();
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
