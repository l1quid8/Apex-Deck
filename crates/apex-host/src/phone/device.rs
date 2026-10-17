//! Choosing, finding and remembering the shared phone's simulator device.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

const NO_SIMULATOR: &str =
    "No iOS simulator is installed. Add one in Xcode › Settings › Components.";

/// The device Deck made for the phone, remembered between runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedDevice {
    pub udid: String,
    pub name: String,
    #[serde(default)]
    pub points: Option<(f64, f64)>,
}

/// A name that is the same for one data folder and different for another, so a
/// dev build and the installed app never share a simulator.
pub fn device_name(data: &Path) -> String {
    let digest = Sha256::digest(data.as_os_str().as_encoded_bytes());
    format!("Apex Deck Phone {:02x}{:02x}", digest[0], digest[1])
}

fn version_of(runtime: &Value) -> Vec<u32> {
    runtime["version"]
        .as_str()
        .unwrap_or("")
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// `(runtime_id, device_type_id)` from `simctl list -j`: the newest available iOS,
/// and in it iPhone 17 Pro, else the first iPhone.
pub fn pick(list_json: &str) -> Result<(String, String), String> {
    let list: Value = serde_json::from_str(list_json)
        .map_err(|_| "Couldn't read the list of simulators.".to_string())?;
    let runtime = list["runtimes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["platform"] == "iOS" && r["isAvailable"] == true)
        .max_by_key(|r| version_of(r))
        .ok_or(NO_SIMULATOR)?;
    let types = || {
        runtime["supportedDeviceTypes"]
            .as_array()
            .into_iter()
            .flatten()
    };
    let device_type = types()
        .find(|t| t["name"] == "iPhone 17 Pro")
        .or_else(|| types().find(|t| t["productFamily"] == "iPhone"))
        .ok_or(NO_SIMULATOR)?;
    match (
        runtime["identifier"].as_str(),
        device_type["identifier"].as_str(),
    ) {
        (Some(runtime), Some(device_type)) => Ok((runtime.into(), device_type.into())),
        _ => Err(NO_SIMULATOR.into()),
    }
}

/// The udid of the usable device with this name, from `simctl list devices -j`.
/// A device marked `isAvailable: false` (its runtime was removed) is skipped; a
/// missing `isAvailable` counts as available.
pub fn find_udid(devices_json: &str, name: &str) -> Option<String> {
    let list: Value = serde_json::from_str(devices_json).ok()?;
    list["devices"]
        .as_object()?
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .find(|d| d["name"] == name && d["isAvailable"] != false)?["udid"]
        .as_str()
        .map(String::from)
}

/// The screen size in points, from the first root of `describe-ui`.
pub fn root_points(describe_json: &str) -> Option<(f64, f64)> {
    let tree: Value = serde_json::from_str(describe_json).ok()?;
    let frame = &tree.as_array()?.first()?["frame"];
    let (w, h) = (frame["width"].as_f64()?, frame["height"].as_f64()?);
    (w > 0.0 && h > 0.0).then_some((w, h))
}

pub fn load(dir: &Path) -> Option<SavedDevice> {
    serde_json::from_slice(&std::fs::read(dir.join("device.json")).ok()?).ok()
}

pub fn save(dir: &Path, device: &SavedDevice) -> Result<(), String> {
    let text = serde_json::to_string_pretty(device).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir)
        .and_then(|_| std::fs::write(dir.join("device.json"), text))
        .map_err(|e| format!("Couldn't save the phone's settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"{"devicetypes":[],"runtimes":[
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","platform":"iOS","version":"18.5","isAvailable":true,
       "supportedDeviceTypes":[{"identifier":"T-16","name":"iPhone 16","productFamily":"iPhone"}]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","platform":"iOS","version":"26.5","isAvailable":true,
       "supportedDeviceTypes":[{"identifier":"T-iPad","name":"iPad Pro","productFamily":"iPad"},
                               {"identifier":"T-17e","name":"iPhone 17e","productFamily":"iPhone"},
                               {"identifier":"T-17P","name":"iPhone 17 Pro","productFamily":"iPhone"}]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-27-0","platform":"iOS","version":"27.0","isAvailable":false,"supportedDeviceTypes":[]},
      {"identifier":"com.apple.CoreSimulator.SimRuntime.watchOS-26-0","platform":"watchOS","version":"26.0","isAvailable":true,"supportedDeviceTypes":[]}
    ]}"#;

    #[test]
    fn picks_the_newest_available_ios_and_prefers_iphone_17_pro() {
        assert_eq!(
            pick(LIST).unwrap(),
            (
                "com.apple.CoreSimulator.SimRuntime.iOS-26-5".into(),
                "T-17P".into()
            )
        );
        let no_pro = LIST.replace(r#""name":"iPhone 17 Pro""#, r#""name":"iPhone 17 Plus""#);
        assert_eq!(pick(&no_pro).unwrap().1, "T-17e");
        assert_eq!(
            pick(r#"{"runtimes":[]}"#).unwrap_err(),
            "No iOS simulator is installed. Add one in Xcode › Settings › Components."
        );
    }

    #[test]
    fn finds_our_device_by_name() {
        let devices = r#"{"devices":{"rt-a":[{"udid":"A","name":"iPhone 17 Pro"}],"rt-b":[{"udid":"B","name":"Apex Deck Phone 1a2b"}]}}"#;
        assert_eq!(find_udid(devices, "Apex Deck Phone 1a2b"), Some("B".into()));
        assert_eq!(find_udid(devices, "Apex Deck Phone ffff"), None);
    }

    #[test]
    fn ignores_devices_that_are_no_longer_available() {
        let gone = r#"{"devices":{"rt-old":[{"udid":"OLD","name":"Apex Deck Phone 1a2b","isAvailable":false,"availabilityError":"runtime profile not found"}]}}"#;
        assert_eq!(find_udid(gone, "Apex Deck Phone 1a2b"), None);
        let both = r#"{"devices":{"rt-old":[{"udid":"OLD","name":"Apex Deck Phone 1a2b","isAvailable":false}],"rt-new":[{"udid":"NEW","name":"Apex Deck Phone 1a2b","isAvailable":true}]}}"#;
        assert_eq!(find_udid(both, "Apex Deck Phone 1a2b"), Some("NEW".into()));
    }

    #[test]
    fn device_names_differ_per_data_folder() {
        let a = device_name(Path::new(
            "/Users/x/Library/Application Support/dev.apexdeck.app",
        ));
        let b = device_name(Path::new("/tmp/other-data"));
        assert!(
            a.starts_with("Apex Deck Phone ") && a.len() == "Apex Deck Phone ".len() + 4,
            "{a}"
        );
        assert_ne!(a, b);
        assert_eq!(
            a,
            device_name(Path::new(
                "/Users/x/Library/Application Support/dev.apexdeck.app"
            ))
        );
    }

    #[test]
    fn root_points_reads_the_screen_size() {
        assert_eq!(
            root_points(
                r#"[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874}}]"#
            ),
            Some((402.0, 874.0))
        );
        assert_eq!(root_points("[]"), None);
    }

    #[test]
    fn saved_device_round_trips() {
        let dir = std::env::temp_dir().join(format!("apex-phone-device-{}", std::process::id()));
        let device = SavedDevice {
            udid: "U".into(),
            name: "Apex Deck Phone 0000".into(),
            points: Some((402.0, 874.0)),
        };
        save(&dir, &device).unwrap();
        assert_eq!(load(&dir), Some(device));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
