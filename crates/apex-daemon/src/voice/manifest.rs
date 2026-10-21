use serde::Deserialize;
use std::path::{Component, Path};
pub const LINUX_X86_64: &str =
    include_str!("../../../../voice-sidecar/runtime-manifest-linux-x86_64.json");
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub python: Item,
    pub wheels: Vec<Wheel>,
    pub models: Vec<Model>,
    pub download_bytes: u64,
    pub required_disk_bytes: u64,
}
#[derive(Clone, Deserialize)]
pub struct Item {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Deserialize)]
pub struct Wheel {
    pub name: String,
    pub version: String,
    pub filename: String,
    #[serde(flatten)]
    pub item: Item,
}
#[derive(Clone, Deserialize)]
pub struct Model {
    pub path: String,
    #[serde(flatten)]
    pub item: Item,
}
fn safe(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && !path.contains('\\')
}
pub fn parse(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if !safe(&m.version) || m.version.contains('/') || m.platform != "linux" || m.arch != "x86_64" {
        return Err("Invalid voice runtime platform or version".into());
    }
    let mut total = 0u64;
    for i in std::iter::once(&m.python)
        .chain(m.wheels.iter().map(|x| &x.item))
        .chain(m.models.iter().map(|x| &x.item))
    {
        if !i.url.starts_with("https://")
            || i.sha256.len() != 64
            || !i.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || i.size == 0
        {
            return Err("Invalid voice runtime download".into());
        }
        total = total
            .checked_add(i.size)
            .ok_or("Invalid voice runtime totals")?;
    }
    if m.wheels.iter().any(|w| {
        !safe(&w.filename)
            || w.filename.contains('/')
            || matches!(w.name.as_str(), "torch" | "torchaudio" | "triton")
            || w.name.starts_with("nvidia-")
            || w.name.starts_with("mlx")
    }) || m
        .models
        .iter()
        .any(|x| !safe(&x.path) || !x.path.starts_with("models/"))
    {
        return Err("Unsafe voice runtime path or package".into());
    }
    if total != m.download_bytes || total.checked_mul(3) != Some(m.required_disk_bytes) {
        return Err("Invalid voice runtime totals".into());
    }
    Ok(m)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_is_valid() {
        let m = parse(LINUX_X86_64).unwrap();
        assert_eq!(m.platform, "linux");
    }
    #[test]
    fn paths_cannot_escape() {
        assert!(!safe("models/../x"));
        assert!(!safe("/x"));
        assert!(!safe("models\\x"));
    }
}
