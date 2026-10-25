//! Compatibility adapter for testing the display-aware phone transport with an
//! already-running Deck daemon. Install only via scripts/install-phone-screen-bridge.mjs.
//! A normal new daemon uses phone::screens directly; unrelated AXe commands and
//! devices are always delegated to the preserved, pinned AXe binary.
#[cfg(unix)]
use apex_host::phone::{self, screens, Frame};
#[cfg(unix)]
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::{
    io::Write,
    path::PathBuf,
    sync::{atomic::AtomicU64, Arc, Mutex},
    time::Duration,
};

#[cfg(unix)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    data: PathBuf,
    udid: String,
    legacy: PathBuf,
    touch: PathBuf,
    developer: String,
}

#[cfg(unix)]
fn option<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].as_str())
}
#[cfg(unix)]
fn legacy(config: &Config, args: &[String]) -> ! {
    let error = std::process::Command::new(&config.legacy).args(args).exec();
    eprintln!("Couldn't run the preserved AXe: {error}");
    std::process::exit(1)
}

#[cfg(unix)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe()?;
    let config: Config = serde_json::from_slice(&std::fs::read(
        exe.parent().unwrap().join("deck-screen-bridge.json"),
    )?)?;
    if option(&args, "--udid") != Some(config.udid.as_str()) {
        legacy(&config, &args);
    }
    let geometry = config.data.join("phone").join("bridge-frame.json");
    match args.first().map(String::as_str) {
        Some("stream-video") => {
            let frame: Arc<Mutex<Option<Frame>>> = Arc::new(Mutex::new(None));
            let task = tokio::spawn(screens::stream(
                PathBuf::from("/usr/bin/xcrun"),
                config.udid.clone(),
                frame.clone(),
                Arc::new(AtomicU64::new(0)),
            ));
            // Old daemons have no frame-invalidation wire message. Revoke
            // geometry before capture, and replace a lost feed with a visible
            // unavailable picture before exiting so their retry loop reconnects.
            let _ = std::fs::remove_file(&geometry);
            let began = std::time::Instant::now();
            let mut sent = 0;
            let mut output = std::io::stdout().lock();
            loop {
                let latest = frame.lock().unwrap().clone();
                if task.is_finished()
                    || (latest.is_none() && (sent > 0 || began.elapsed() > Duration::from_secs(8)))
                {
                    let _ = std::fs::remove_file(&geometry);
                    let unavailable = include_bytes!("phone-unavailable.jpg");
                    output.write_all(&(unavailable.len() as u32).to_be_bytes())?;
                    output.write_all(unavailable)?;
                    output.flush()?;
                    task.abort();
                    return Err("The phone feed is unavailable; reconnecting.".into());
                }
                if let Some(latest) = latest.filter(|f| f.seq != sent) {
                    if let Some(screen) = &latest.screen {
                        let state = serde_json::json!({"id":screen.id,"orientation":screen.orientation,"width":latest.width,"height":latest.height});
                        let temporary = geometry.with_extension("part");
                        std::fs::write(&temporary, serde_json::to_vec(&state)?)?;
                        std::fs::rename(temporary, &geometry)?;
                    }
                    output.write_all(&(latest.jpeg.len() as u32).to_be_bytes())?;
                    output.write_all(&latest.jpeg)?;
                    output.flush()?;
                    sent = latest.seq;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        Some("type") if args.iter().any(|a| a == "--stdin") => {
            let error = std::process::Command::new(&config.touch)
                .args([config.developer, config.udid, "type".into()])
                .exec();
            return Err(error.into());
        }
        Some("key") => {
            let key: u8 = args.get(1).ok_or("Missing keycode")?.parse()?;
            let error = std::process::Command::new(&config.touch)
                .args([config.developer, config.udid, "key".into(), key.to_string()])
                .exec();
            return Err(error.into());
        }
        Some("tap" | "swipe") if option(&args, "--label").is_none() => {
            // The old host converts picture pixels through its persisted point
            // width. Undo that conversion at this compatibility boundary only.
            let saved = phone::device::load(&config.data.join("phone"))
                .ok_or("No shared device settings")?;
            let base = saved.points.ok_or("No shared point size")?.0;
            let state: serde_json::Value = serde_json::from_slice(&std::fs::read(&geometry)?)?;
            let id = state["id"].as_u64().ok_or("No display ID")? as u32;
            let orientation = state["orientation"]
                .as_u64()
                .ok_or("No display orientation")? as u32;
            let width = state["width"].as_f64().ok_or("No frame width")?;
            let height = state["height"].as_f64().ok_or("No frame height")?;
            let screen = screens::Screen { id, orientation, ..Default::default() };
            let point = |x: &str, y: &str| -> Result<(f64, f64), Box<dyn std::error::Error>> {
                let x: f64 = option(&args, x).ok_or("Missing x")?.parse()?;
                let y: f64 = option(&args, y).ok_or("Missing y")?.parse()?;
                Ok(screens::touch_ratio(
                    &screen,
                    x / base,
                    y / base * width / height,
                ))
            };
            let (start, end, ms) = if args[0] == "tap" {
                let p = point("-x", "-y")?;
                (p, p, 100)
            } else {
                (
                    point("--start-x", "--start-y")?,
                    point("--end-x", "--end-y")?,
                    (option(&args, "--duration")
                        .unwrap_or("0.3")
                        .parse::<f64>()?
                        * 1000.0)
                        .clamp(100.0, 1000.0) as u32,
                )
            };
            let error = std::process::Command::new(&config.touch)
                .args([
                    config.developer,
                    config.udid,
                    id.to_string(),
                    start.0.to_string(),
                    start.1.to_string(),
                    end.0.to_string(),
                    end.1.to_string(),
                    ms.to_string(),
                ])
                .exec();
            return Err(error.into());
        }
        _ => legacy(&config, &args),
    }
}

#[cfg(not(unix))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    Err("The phone screen bridge is unavailable on this platform.".into())
}
