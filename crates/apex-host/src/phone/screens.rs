//! Display geometry for simulators with more than one integrated screen.
use image::{DynamicImage, GenericImageView};

#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: u32,
    pub id: u32,
    pub orientation: u32,
}

impl Default for Screen {
    fn default() -> Self { Self { id: 1, orientation: 1, pixel_width: 0, pixel_height: 0, scale: 1 } }
}

/// `simctl io enumerate` lists connected screens separately from IO ports.
/// Only integrated displays participate; TVOut, CarPlay and resizable scenes do not.
pub fn parse(listing: &str) -> Vec<Screen> {
    let mut screens = Vec::new();
    let mut id = None;
    let mut integrated = false;
    let mut orientation = 1;
    let mut scale = 1;
    let save = |screens: &mut Vec<Screen>, id: Option<u32>, integrated: bool, orientation: u32, scale: u32| {
        if let Some(id) = id.filter(|_| integrated) {
            screens.push(Screen { id, orientation, scale, ..Screen::default() });
        }
    };
    for line in listing.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("Screen ID: ") {
            save(&mut screens, id, integrated, orientation, scale);
            id = value.parse::<u32>().ok().filter(|id| (1..=10).contains(id));
            integrated = false;
            orientation = 1;
            scale = 1;
        } else if let Some(value) = line.strip_prefix("Screen Type: ") {
            integrated = value == "Integrated";
        } else if let Some(value) = line.strip_prefix("Preferred UI Scale: ") {
            scale = value.parse().unwrap_or(1);
        } else if let Some(value) = line.strip_prefix("UI Orientation: ") {
            orientation = match value {
                "Portrait Upside Down" => 2,
                "Landscape Left" => 3,
                "Landscape Right" => 4,
                _ => 1,
            };
        }
    }
    save(&mut screens, id, integrated, orientation, scale);
    screens.sort_by_key(|screen| screen.id);
    screens.dedup_by_key(|screen| screen.id);
    screens
}

/// Initial point geometry from simctl, avoiding AX accessibility on new runtimes.
/// The live frame replaces it with the active panel's rotated geometry for input.
pub fn panel_points(listing: &str) -> Option<(f64, f64)> {
    let mut size = None;
    for line in listing.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("Pixel Size: {").and_then(|s| s.strip_suffix('}')) {
            if let Some((w, h)) = value.split_once(',') { size = w.trim().parse::<f64>().ok().zip(h.trim().parse::<f64>().ok()); }
        }
        if let Some(scale) = line.strip_prefix("Preferred UI Scale: ").and_then(|s| s.parse::<f64>().ok()).filter(|s| *s > 0.0) {
            if let Some((w, h)) = size.filter(|(w, h)| *w > 0.0 && *h > 0.0) { return Some((w / scale, h / scale)); }
        }
    }
    None
}

/// DTUHID uses the panel's unrotated coordinates, not screenshot coordinates.
pub fn touch_ratio(screen: &Screen, x: f64, y: f64) -> (f64, f64) {
    match screen.orientation {
        2 => (1.0 - x, 1.0 - y),
        3 => (y, 1.0 - x),
        4 => (1.0 - y, x),
        _ => (x, y),
    }
}

/// The inactive Duo panel captures as black. Keep the previous panel when
/// both are blank (lock/off) or lit, rather than guessing from their sizes.
/// Sample the whole thumbnail so dark app backgrounds still count as visible.
pub fn visible(image: &DynamicImage) -> bool {
    (0..image.height())
        .step_by((image.height() / 64).max(1) as usize)
        .any(|y| {
            (0..image.width())
                .step_by((image.width() / 64).max(1) as usize)
                .any(|x| image.get_pixel(x, y).0[..3].iter().any(|&v| v > 3))
        })
}

fn choose(candidates: &[(Screen, DynamicImage)], previous: Option<u32>) -> Option<usize> {
    let old = candidates
        .iter()
        .position(|(screen, _)| Some(screen.id) == previous);
    old.filter(|&i| visible(&candidates[i].1))
        .or_else(|| candidates.iter().position(|(_, image)| visible(image)))
        .or(old)
        .or_else(|| (!candidates.is_empty()).then_some(0))
}

async fn capture(
    xcrun: &std::path::Path,
    udid: &str,
    screen: &Screen,
    directory: &std::path::Path,
) -> Result<DynamicImage, String> {
    // Xcode 27.1 documents '-' as stdout but writes a file literally named
    // '-' instead. Use a private per-stream directory and read the file.
    let path = directory.join(format!("{}.png", screen.id));
    let operation = tokio::process::Command::new(xcrun)
        .args([
            "simctl",
            "io",
            udid,
            "screenshot",
            &format!("--display={}", screen.id),
            "--type=png",
        ])
        .arg(&path)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(4), operation)
        .await
        .map_err(|_| "The simulator screenshot timed out.")?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "The simulator display is unavailable: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    image::load_from_memory(&tokio::fs::read(path).await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Automatic following for startup and externally controlled devices.
pub async fn stream(
    xcrun: std::path::PathBuf,
    udid: String,
    frame: std::sync::Arc<std::sync::Mutex<Option<super::Frame>>>,
    seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
) { stream_preferred(xcrun, udid, frame, seq, None).await; }

/// After an owned pose change, favor its destination even when the inactive
/// panel retains a lit framebuffer. Fall back when that panel is black.
pub async fn stream_preferred(
    xcrun: std::path::PathBuf,
    udid: String,
    frame: std::sync::Arc<std::sync::Mutex<Option<super::Frame>>>,
    seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
    preferred: Option<u32>,
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct CaptureDirectory(std::path::PathBuf);
    impl Drop for CaptureDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let directory = CaptureDirectory(std::env::temp_dir().join(format!(
        "apex-phone-displays-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    if tokio::fs::create_dir_all(&directory.0).await.is_err() {
        return;
    }
    let mut previous = preferred;
    loop {
        let listing =
            super::simctl(&xcrun, &["io", &udid, "enumerate"], Duration::from_secs(4)).await;
        let screens = listing.as_deref().map(parse).unwrap_or_default();
        let results = futures::future::join_all(
            screens
                .iter()
                .map(|screen| capture(&xcrun, &udid, screen, &directory.0)),
        )
        .await;
        let candidates: Vec<_> = screens
            .into_iter()
            .zip(results)
            .filter_map(|(screen, result)| match result {
                Ok(image) => Some((screen, image)),
                Err(error) => {
                    eprintln!("Phone display {}: {error}", screen.id);
                    None
                }
            })
            .collect();
        // Require every panel to be captured: a partial failure must not silently
        // select another display and route the next tap to the wrong panel.
        let complete = listing
            .as_deref()
            .map(parse)
            .is_ok_and(|screens| !screens.is_empty() && screens.len() == candidates.len());
        let selected = complete.then(|| choose(&candidates, preferred.or(previous))).flatten();
        if let Some(index) = selected {
            let (screen, image) = &candidates[index];
            let mut screen = screen.clone();
            screen.pixel_width = image.width();
            screen.pixel_height = image.height();
            let image = image.clone();
            let encoded = tokio::task::spawn_blocking(move || {
                let image = image
                    .resize(
                        (image.width() / 2).max(1),
                        (image.height() / 2).max(1),
                        image::imageops::FilterType::Nearest,
                    )
                    .to_rgb8();
                let mut jpeg = Vec::new();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 60)
                    .encode_image(&image)
                    .ok()?;
                Some((screen, jpeg, image.width(), image.height()))
            })
            .await
            .ok()
            .flatten();
            if let Some((screen, jpeg, width, height)) = encoded {
                previous = Some(screen.id);
                *super::locked(&frame) = Some(super::Frame {
                    seq: seq.fetch_add(1, Ordering::Relaxed) + 1,
                    jpeg,
                    width,
                    height,
                    screen: Some(screen),
                });
            } else {
                *super::locked(&frame) = None;
            }
        } else {
            *super::locked(&frame) = None;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn live_frames_switch_panels_and_keep_their_touch_geometry() {
        use std::{
            os::unix::fs::PermissionsExt,
            sync::{atomic::AtomicU64, Arc, Mutex},
            time::Duration,
        };
        let directory =
            std::env::temp_dir().join(format!("apex-screen-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let listing = "Screen ID: 1\nScreen Type: Integrated\nUI Orientation: Portrait\nScreen ID: 3\nScreen Type: Integrated\nUI Orientation: Landscape Left\n";
        std::fs::write(directory.join("listing"), listing).unwrap();
        std::fs::write(directory.join("active"), "both").unwrap();
        for (name, w, h, color) in [
            ("1", 100, 200, [10, 20, 30]),
            ("3", 300, 200, [30, 20, 10]),
            ("black", 100, 200, [0, 0, 0]),
        ] {
            image::RgbImage::from_pixel(w, h, image::Rgb(color))
                .save(directory.join(format!("{name}.png")))
                .unwrap();
        }
        let program = directory.join("xcrun");
        std::fs::write(
            &program,
            r#"#!/bin/sh
cd "$(dirname "$0")" || exit 1
case "$4" in
  enumerate) cat listing ;;
  screenshot)
    id=${5#--display=}
    if [ "$(cat active)" = "both" ] || [ "$id" = "$(cat active)" ]; then cp "$id.png" "$7"; else cp black.png "$7"; fi ;;
  *) exit 2 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let frame = Arc::new(Mutex::new(None));
        let task = tokio::spawn(stream_preferred(
            program,
            "U".into(),
            frame.clone(),
            Arc::new(AtomicU64::new(0)),
            Some(3),
        ));
        let wait_for = |id| {
            let frame = frame.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(4), async move {
                    loop {
                        if let Some(frame) =
                            frame
                                .lock()
                                .unwrap()
                                .clone()
                                .filter(|f: &super::super::Frame| {
                                    f.screen.as_ref().is_some_and(|s| s.id == id)
                                })
                        {
                            break frame;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap()
            }
        };
        let inner = wait_for(3).await;
        assert_eq!((inner.width, inner.height), (150, 100));
        assert_eq!(inner.screen.as_ref().unwrap().orientation, 3);
        std::fs::write(directory.join("active"), "1").unwrap();
        let outer = wait_for(1).await;
        assert_eq!((outer.width, outer.height), (50, 100));
        assert!(outer.seq > inner.seq);
        // The destination may still be dark in the first capture after a pose
        // change. Its preference must survive that fallback once it lights up.
        std::fs::write(directory.join("active"), "both").unwrap();
        let restored = wait_for(3).await;
        assert!(restored.seq > outer.seq);
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn discovers_integrated_displays_without_treating_tvout_as_a_phone_screen() {
        let listing = "    (2) TVOut:\n        Screen ID: 2\n        Screen Type: TVOut\n        UI Orientation: Ambiguous\n    (3) LCD-1:\n        Screen ID: 3\n        Screen Type: Integrated\n        UI Orientation: Landscape Left\n    (1) LCD:\n        Screen ID: 1\n        Screen Type: Integrated\n        UI Orientation: Portrait\n";
        assert_eq!(
            parse(listing),
            vec![
                Screen {
                    id: 1,
                    orientation: 1, ..Screen::default()
                },
                Screen {
                    id: 3,
                    orientation: 3, ..Screen::default()
                }
            ]
        );
    }
    #[test]
    fn landscape_touches_follow_the_same_inner_screen_as_the_picture() {
        let screen = Screen {
            id: 3,
            orientation: 3, ..Screen::default()
        };
        let (x, y) = touch_ratio(&screen, 0.665, 0.9);
        assert!((x - 0.9).abs() < 1e-9 && (y - 0.335).abs() < 1e-9);
        assert_eq!(
            touch_ratio(
                &Screen {
                    id: 1,
                    orientation: 1, ..Screen::default()
                },
                0.2,
                0.8
            ),
            (0.2, 0.8)
        );
        let (x, y) = touch_ratio(
            &Screen {
                id: 3,
                orientation: 4, ..Screen::default()
            },
            0.2,
            0.8,
        );
        assert!((x - 0.2).abs() < 1e-9 && (y - 0.2).abs() < 1e-9);
    }
    #[test]
    fn inactive_displays_are_black_but_a_dark_app_is_still_visible() {
        let black = DynamicImage::new_rgb8(100, 100);
        assert!(!visible(&black));
        let dark = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            100,
            100,
            image::Rgb([8, 12, 16]),
        ));
        assert!(visible(&dark));
    }
}
