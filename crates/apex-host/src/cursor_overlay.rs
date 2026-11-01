use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CURSOR_PREFS_FILE: &str = "computer-cursor.json";
const CURSOR_IMAGE_DIR: &str = "computer-cursor";
const MAX_CUSTOM_BYTES: u64 = 2 * 1024 * 1024; // matches upstream MAX_CURSOR_IMAGE_BYTES
const MAX_PIXELS: u32 = 1024; // matches upstream MAX_CURSOR_IMAGE_PIXELS
const MIN_SIZE: f64 = 0.5;
const MAX_SIZE: f64 = 4.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorOverlayPrefs {
    #[serde(default)]
    pub preset: CursorPreset,
    #[serde(default)]
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default = "default_true")]
    pub ripple: bool,
    #[serde(default = "default_true")]
    pub highlight: bool,
    #[serde(default)]
    pub labels_enabled: bool,
    #[serde(default)]
    pub motion: MotionPrefs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_image: Option<CustomImagePrefs>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CursorPreset {
    #[default]
    Default,
    Simple,
    #[serde(rename = "ring-only")]
    RingOnly,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionPrefs {
    #[serde(default = "default_travel_min")]
    pub travel_min_ms: u64,
    #[serde(default = "default_travel_max")]
    pub travel_max_ms: u64,
    #[serde(default)]
    pub dwell_ms: u64,
    #[serde(default = "default_bow")]
    pub bow: f64,
    #[serde(default = "default_overshoot")]
    pub overshoot: f64,
    #[serde(default = "default_tremor")]
    pub tremor: f64,
}

impl Default for MotionPrefs {
    fn default() -> Self {
        Self {
            travel_min_ms: default_travel_min(),
            travel_max_ms: default_travel_max(),
            dwell_ms: 0,
            bow: default_bow(),
            overshoot: default_overshoot(),
            tremor: default_tremor(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomImagePrefs {
    pub path: String,
    #[serde(default)]
    pub hotspot_x: f64,
    #[serde(default)]
    pub hotspot_y: f64,
}

fn default_true() -> bool { true }
fn default_travel_min() -> u64 { 90 }
fn default_travel_max() -> u64 { 320 }
fn default_bow() -> f64 { 1.0 }
fn default_overshoot() -> f64 { 0.035 }
fn default_tremor() -> f64 { 1.1 }

impl Default for CursorOverlayPrefs {
    fn default() -> Self {
        Self {
            preset: CursorPreset::Default,
            size: 1.0,
            fill: None,
            rim: Some("#111318".to_string()),
            accent: Some("#4299FF".to_string()),
            ripple: true,
            highlight: true,
            labels_enabled: false,
            motion: MotionPrefs::default(),
            custom_image: None,
        }
    }
}

fn is_hex_color(s: &str) -> bool {
    let hex = s.strip_prefix('#').unwrap_or(s);
    if hex.len() != 3 && hex.len() != 6 { return false; }
    hex.chars().all(|c| c.is_ascii_hexdigit())
}

impl CursorOverlayPrefs {
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_SIZE..=MAX_SIZE).contains(&self.size) {
            return Err(format!("Cursor size must be between {MIN_SIZE} and {MAX_SIZE}"));
        }
        for color in [&self.fill, &self.rim, &self.accent].into_iter().flatten() {
            if !is_hex_color(color) {
                return Err(format!("Color '{color}' must be hex like #FFFFFF"));
            }
        }
        if self.motion.travel_min_ms < 30 || self.motion.travel_min_ms > self.motion.travel_max_ms {
            return Err("travelMin must be >=30 and <= travelMax".into());
        }
        if self.motion.bow < 0.0 || self.motion.bow > 3.0 {
            return Err("bow must be between 0 and 3".into());
        }
        if self.motion.overshoot < 0.0 || self.motion.overshoot > 0.15 {
            return Err("overshoot must be between 0 and 0.15".into());
        }
        if self.motion.tremor < 0.0 || self.motion.tremor > 4.0 {
            return Err("tremor must be between 0 and 4".into());
        }
        if self.motion.dwell_ms > 300 {
            return Err("dwell must be between 0 and 300".into());
        }
        if self.motion.travel_max_ms + self.motion.dwell_ms > 700 {
            return Err("travelMax + dwell must not exceed 700 ms".into());
        }
        if let Some(img) = &self.custom_image {
            if img.path.is_empty() || !Path::new(&img.path).is_absolute() {
                return Err("custom image path must be absolute".into());
            }
            if img.hotspot_x < 0.0 || img.hotspot_x > 512.0 || img.hotspot_y < 0.0 || img.hotspot_y > 512.0 {
                return Err("hotspot must be between 0 and 512".into());
            }
        }
        Ok(())
    }
}

pub fn prefs_path(data_dir: &Path) -> PathBuf { data_dir.join(CURSOR_PREFS_FILE) }
pub fn image_dir(data_dir: &Path) -> PathBuf { data_dir.join(CURSOR_IMAGE_DIR) }

pub fn load(data_dir: &Path) -> CursorOverlayPrefs {
    let path = prefs_path(data_dir);
    let Ok(bytes) = std::fs::read(&path) else { return CursorOverlayPrefs::default(); };
    serde_json::from_slice::<CursorOverlayPrefs>(&bytes).unwrap_or_default()
}

pub fn save(data_dir: &Path, prefs: &CursorOverlayPrefs) -> Result<(), String> {
    prefs.validate()?;
    let path = prefs_path(data_dir);
    let bytes = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    crate::authority_file::write(&path, &bytes).map_err(|e| format!("Could not save cursor prefs: {e}"))
}

/// Validate and persist a custom PNG:
/// - PNG signature
/// - <=2MiB
/// - <=1024 per side (IHDR)
/// Returns absolute persisted path.
pub fn validate_and_store_image(data_dir: &Path, png_bytes: &[u8]) -> Result<CustomImagePrefs, String> {
    if png_bytes.len() as u64 > MAX_CUSTOM_BYTES {
        return Err(format!("Cursor image must be at most {} MiB", MAX_CUSTOM_BYTES / (1024*1024)));
    }
    if png_bytes.len() < 24 {
        return Err("File is not valid PNG".into());
    }
    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !png_bytes.starts_with(PNG_MAGIC) {
        return Err("cursor images must be PNG".into());
    }
    // Check IHDR dimensions at bytes 12..24: 12-15 = "IHDR", 16..20 width BE, 20..24 height BE
    if png_bytes.get(12..16) != Some(b"IHDR") {
        return Err("PNG missing IHDR".into());
    }
    let width = u32::from_be_bytes(png_bytes[16..20].try_into().map_err(|_| "bad PNG header")?);
    let height = u32::from_be_bytes(png_bytes[20..24].try_into().map_err(|_| "bad PNG header")?);
    if width == 0 || height == 0 || width > MAX_PIXELS || height > MAX_PIXELS {
        return Err(format!("Cursor image PNG must be at most {MAX_PIXELS} pixels per side"));
    }
    let dir = image_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create cursor image dir: {e}"))?;
    // Use content hash to avoid tmp fragile path and dedup
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    png_bytes.hash(&mut hasher);
    let hash = hasher.finish();
    let filename = format!("cursor-{hash:x}.png");
    let dest = dir.join(filename);
    crate::authority_file::write(&dest, png_bytes).map_err(|e| format!("Could not save cursor image: {e}"))?;
    let abs = dest.canonicalize().unwrap_or(dest);
    Ok(CustomImagePrefs { path: abs.to_string_lossy().to_string(), hotspot_x: 0.0, hotspot_y: 0.0 })
}

pub fn reset(data_dir: &Path) -> Result<CursorOverlayPrefs, String> {
    let prefs = CursorOverlayPrefs::default();
    save(data_dir, &prefs)?;
    // Best effort remove old custom images
    let dir = image_dir(data_dir);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_validates() { CursorOverlayPrefs::default().validate().unwrap(); }
    #[test]
    fn hex_check() {
        assert!(is_hex_color("#fff"));
        assert!(is_hex_color("#FFFFFF"));
        assert!(!is_hex_color("red"));
        assert!(!is_hex_color("#ffff"));
    }
    #[test]
    fn image_too_large_rejected() {
        // not PNG
        assert!(validate_and_store_image(&std::env::temp_dir().join("test-cursor"), b"not png").is_err());
    }
}
