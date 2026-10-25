//! Shared simulator controls for the Phone toolbar and bot commands.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};

#[derive(Default)]
pub(super) struct Extra {
    pub transitioning: bool,
    pub unconfirmed: bool,
    pub preferred_display: Option<u32>,
    pub physical_orientation: Option<u32>,
    pub generation: u64,
    pub displays: usize,
    pub model: Option<String>,
    pub runtime: Option<String>,
    pub appearance: Option<String>,
    pub text_size: Option<String>,
    pub contrast: Option<bool>,
    pub recording: Option<Recording>,
    pub hid: Option<HidSession>,
    pub last_capture: Option<String>,
}
pub(super) struct Recording {
    child: tokio::process::Child,
    pub(super) path: String,
}

// Keep the guest service alive: cancelling it immediately after dispatch can
// invalidate a hinge update before CoreMotion consumes it. All sends are under
// Phone.actions, and the session is closed before device shutdown/switching.
pub(super) struct HidSession {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    replies: Lines<BufReader<tokio::process::ChildStdout>>,
    udid: String,
}
impl HidSession {
    fn spawn(xcrun: &Path, udid: &str, program: &Path) -> Result<Self, String> {
        let mut child = tokio::process::Command::new(xcrun)
            .args(["simctl", "spawn", udid])
            .arg(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child
            .stdin
            .take()
            .ok_or("Native controls have no input pipe.")?;
        let replies = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Native controls have no reply pipe.")?,
        )
        .lines();
        Ok(Self {
            child,
            input,
            replies,
            udid: udid.into(),
        })
    }
    async fn send(&mut self, line: &str) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(15), async {
            self.input.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| e.to_string())?;
            self.input.flush().await.map_err(|e| e.to_string())?;
            for _ in line.lines() {
                if self.replies.next_line().await.map_err(|e| e.to_string())?.as_deref() != Some("OK") {
                    return Err("This Xcode/runtime does not support native hinge or hardware controls. Update Xcode and try again.".into());
                }
            }
            Ok(())
        }).await.map_err(|_| "Native controls timed out. The action was not retried; check the Phone picture.".to_string())?
    }
}

pub fn validate(control: &Control) -> Result<(), String> {
    match control {
        Control::Rotate { orientation } if !(1..=4).contains(orientation) => {
            Err("Choose portrait, upside-down, landscape-left or landscape-right.".into())
        }
        Control::Appearance { value } if !["light", "dark"].contains(&value.as_str()) => {
            Err("Appearance must be light or dark.".into())
        }
        Control::TextSize { value }
            if ![
                "increment",
                "decrement",
                "extra-small",
                "small",
                "medium",
                "large",
                "extra-large",
                "extra-extra-large",
                "extra-extra-extra-large",
                "accessibility-medium",
                "accessibility-large",
                "accessibility-extra-large",
                "accessibility-extra-extra-large",
                "accessibility-extra-extra-extra-large",
            ]
            .contains(&value.as_str()) =>
        {
            Err("Choose a standard simulator text size.".into())
        }
        Control::Volume { direction } if !["up", "down"].contains(&direction.as_str()) => {
            Err("Volume needs up or down.".into())
        }
        Control::Location {
            latitude,
            longitude,
        } => match (latitude, longitude) {
            (None, None) => Ok(()),
            (Some(a), Some(b))
                if a.is_finite()
                    && b.is_finite()
                    && (-90.0..=90.0).contains(a)
                    && (-180.0..=180.0).contains(b) =>
            {
                Ok(())
            }
            _ => Err(
                "Enter latitude from -90 to 90 and longitude from -180 to 180, or reset both."
                    .into(),
            ),
        },
        _ => Ok(()),
    }
}
fn recording_geometry_changed(expected: &Geometry, current: &Geometry) -> bool {
    current.width > 0
        && current.height > 0
        && (current.display != expected.display
            || current.orientation != expected.orientation
            || current.width != expected.width
            || current.height != expected.height)
}

pub(super) fn geometry_of(frame: Option<&Frame>, generation: u64) -> Geometry {
    Geometry {
        generation,
        display: frame.and_then(|f| f.screen.as_ref()).map_or(1, |s| s.id),
        orientation: frame
            .and_then(|f| f.screen.as_ref())
            .map_or(1, |s| s.orientation),
        width: frame.map_or(0, |f| f.width),
        height: frame.map_or(0, |f| f.height),
    }
}

pub(super) fn hardware_usage(button: HwButton) -> u32 {
    match button {
        HwButton::Home => 0x40,
        HwButton::Lock => 0x30,
    }
}

pub fn check_geometry(expected: Option<&Geometry>, current: &Geometry) -> Result<(), String> {
    if expected.is_some_and(|e| e != current) {
        Err("The phone's display changed. Try again on the new picture.".into())
    } else {
        Ok(())
    }
}

// Duo's inner panel is mounted a quarter turn from its physical hinge sensor.
// Keep the public contract in framebuffer/UI orientations, also used for touch.
pub(super) fn orientation_event(display: u32, duo: bool, ui: u32) -> u32 {
    if duo && display == 3 {
        match ui {
            1 => 3,
            2 => 4,
            3 => 1,
            4 => 2,
            _ => ui,
        }
    } else {
        ui
    }
}

fn physical_orientation_of(json: &str) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    match value["result"]["deviceOrientationNonFlat"].as_str()
        .or_else(|| value["result"]["deviceOrientation"].as_str())? {
        "portrait" => Some(1),
        "portraitUpsideDown" => Some(2),
        "landscapeLeft" => Some(3),
        "landscapeRight" => Some(4),
        _ => None,
    }
}

async fn confirm_orientation(tools: &Tools, udid: &str, expected: u32) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let json = axe::run_tool(&tools.xcrun, &[
                "devicectl", "device", "orientation", "get", "--device", udid, "--json-output", "-",
            ].map(String::from), None, Duration::from_secs(4)).await?;
            if physical_orientation_of(&json) == Some(expected) { return Ok(()); }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }).await.map_err(|_| "Couldn't confirm the device rotation. Check the Phone picture and try again.".to_string())?
}

/// Compile only our bundled source. Cache separately for the selected simulator SDK.
async fn ensure_hid(data: &Path, xcrun: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    const SOURCE: &str = include_str!("duo-hid.m");
    let sdk = axe::run_tool(
        xcrun,
        &[
            "--sdk".into(),
            "iphonesimulator".into(),
            "--show-sdk-path".into(),
        ],
        None,
        Duration::from_secs(10),
    )
    .await.map_err(|e| format!("Simulator controls need the iOS Simulator SDK from a selected Xcode installation. Open Xcode once and check xcode-select. {e}"))?;
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{SOURCE}/{sdk}/{}", std::env::consts::ARCH))
    );
    let dir = data.join("tools").join(format!("duo-hid-{}", &hash[..16]));
    let program = dir.join("duo-hid");
    if !program.is_file() {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        let source = dir.join("duo-hid.m");
        tokio::fs::write(&source, SOURCE)
            .await
            .map_err(|e| e.to_string())?;
        let part = dir.join("duo-hid.part");
        let arch = if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "x86_64"
        };
        let args: Vec<String> = [
            "--sdk",
            "iphonesimulator",
            "clang",
            "-target",
            &format!("{arch}-apple-ios18.0-simulator"),
            "-isysroot",
            &sdk,
            "-fobjc-arc",
            "-fblocks",
            "-framework",
            "Foundation",
            source.to_str().ok_or("Invalid helper source path")?,
            "-o",
            part.to_str().ok_or("Invalid helper path")?,
        ]
        .map(String::from)
        .into();
        axe::run_tool(xcrun, &args, None, Duration::from_secs(60))
            .await
            .map_err(|e| {
                format!("Simulator controls need a compatible Xcode simulator SDK. {e}")
            })?;
        tokio::fs::rename(&part, &program)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(dir.join("duo-hid-LICENSE"), include_bytes!("duo-hid-LICENSE"))
        .await.map_err(|e| e.to_string())?;
    Ok(program)
}

impl Phone {
    pub(super) async fn hid(&self, xcrun: &Path, udid: &str, line: &str) -> Result<(), String> {
        let known = self.state().extra.hid.take();
        let mut session = match known {
            Some(mut session) => {
                if session.udid == udid
                    && session
                        .child
                        .try_wait()
                        .map_err(|e| e.to_string())?
                        .is_none()
                {
                    session
                } else {
                    HidSession::spawn(xcrun, udid, &ensure_hid(&self.data, xcrun).await?)?
                }
            }
            None => HidSession::spawn(xcrun, udid, &ensure_hid(&self.data, xcrun).await?)?,
        };
        session.send(line).await?;
        self.state().extra.hid = Some(session);
        Ok(())
    }

    pub(super) async fn stop_hid(&self) {
        let known = self.state().extra.hid.take();
        if let Some(mut session) = known {
            drop(session.input);
            let _ = tokio::time::timeout(Duration::from_secs(3), session.child.wait()).await;
        }
    }

    pub async fn devices(&self) -> Result<Vec<DeviceChoice>, String> {
        let xcrun = self
            .state()
            .tools
            .as_ref()
            .map(|t| t.xcrun.clone())
            .unwrap_or_else(|| XCRUN.into());
        device::catalog(
            &simctl(
                &xcrun,
                &["list", "-j", "runtimes", "devicetypes"],
                axe::SIMCTL_LIMIT,
            )
            .await?,
        )
    }

    pub(super) fn geometry(&self) -> Geometry {
        self.snapshot().0.geometry
    }

    pub async fn human_control(&self, control: Control) -> Result<ControlReply, String> {
        validate(&control)?;
        let generation = {
            let mut state = self.state();
            state.lock.begin_human_input(self.now());
            state.starts
        };
        let _human = HumanInput(self, generation);
        let _turn = self.actions.lock().await;
        self.control(control).await
    }

    pub(super) async fn stop_recording(&self) -> Result<Option<String>, String> {
        let recording = self.state().extra.recording.take();
        let Some(mut recording) = recording else {
            return Ok(None);
        };
        #[cfg(unix)]
        if let Some(pid) = recording.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGINT);
            }
        }
        let result = tokio::time::timeout(Duration::from_secs(12), recording.child.wait()).await;
        match result {
            Ok(Ok(status))
                if status.success()
                    && std::fs::metadata(&recording.path).is_ok_and(|m| m.len() > 0) =>
            {
                self.state().extra.last_capture = Some(recording.path.clone());
                Ok(Some(recording.path))
            }
            _ => Err(format!(
                "The recording could not be finalized. Check {} before retrying.",
                recording.path
            )),
        }
    }

    async fn capture_path(&self, extension: &str) -> Result<(PathBuf, Geometry), String> {
        let directory = self.data.join("phone").join("captures");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        // Read actual framebuffer dimensions rather than doubling the downsampled feed.
        let (status, frame) = self.snapshot();
        let frame = frame.ok_or(NO_PICTURE)?;
        let (width, height) = frame
            .screen
            .as_ref()
            .map_or((frame.width, frame.height), |s| {
                (s.pixel_width, s.pixel_height)
            });
        Ok((directory.join(format!(
            "phone-display-{}-{}x{}-{stamp}.{extension}",
            status.geometry.display, width, height
        )), status.geometry))
    }

    /// Called under actions for both UI and bot requests.
    pub(super) async fn control(&self, control: Control) -> Result<ControlReply, String> {
        validate(&control)?;
        if let Control::SelectDevice {
            runtime,
            device_type,
        } = &control
        {
            let choice = self
                .devices()
                .await?
                .into_iter()
                .find(|d| d.runtime == *runtime && d.device_type == *device_type)
                .ok_or("That model/runtime is unavailable. Refresh the device list.")?;
            let tools = self.tools().await?;
            let name = device::selection_name(&self.data, runtime, device_type);
            let listed =
                simctl(&tools.xcrun, &["list", "-j", "devices"], axe::SIMCTL_LIMIT).await?;
            // Synchronize with a boot already in progress before publishing a new
            // selection. A cancelled bring_up must finish all of its writes first.
            self.stop_inner().await?;
            let _starting = self.starting.lock().await;
            self.stop_inner().await?;
            if let Some(saved) = device::load(&self.data.join("phone")) {
                if let Some((rt, kind)) = device::choice_of(&listed, &saved.udid) {
                    device::save(&device::selection_dir(&self.data, &rt, &kind), &saved)?;
                }
            }
            let slot = device::selection_dir(&self.data, runtime, device_type);
            let matches_choice = |udid: &str| device::choice_of(&listed, udid)
                .is_some_and(|(rt, kind)| rt == *runtime && kind == *device_type);
            let adopted = device::load(&slot).filter(|d| matches_choice(&d.udid));
            let udid = match adopted
                .map(|d| d.udid)
                .or_else(|| device::find_udid(&listed, &name).filter(|id| matches_choice(id)))
            {
                Some(id) => id,
                None => {
                    simctl(
                        &tools.xcrun,
                        &["create", &name, device_type, runtime],
                        axe::SIMCTL_LIMIT,
                    )
                    .await?
                }
            };
            let actual_name = serde_json::from_str::<serde_json::Value>(&listed)
                .ok()
                .and_then(|v| {
                    v["devices"].as_object().and_then(|g| {
                        g.values()
                            .filter_map(|d| d.as_array())
                            .flatten()
                            .find(|d| d["udid"] == udid)
                            .and_then(|d| d["name"].as_str().map(String::from))
                    })
                })
                .unwrap_or(name);
            let saved = SavedDevice {
                udid,
                name: actual_name,
                points: None,
            };
            device::save(&slot, &saved)?;
            device::save(&self.data.join("phone"), &saved)?;
            {
                let mut s = self.state();
                s.device = Some(saved);
                s.extra.model = Some(choice.model);
                s.extra.runtime = Some(choice.version);
                s.touch = None;
                s.extra.generation += 1;
            }
            if let Some(me) = self.me.upgrade() {
                me.start();
            }
            return Ok(ControlReply {
                status: self.status(),
                message: "Switching simulator. Its apps and data are preserved.".into(),
                path: None,
            });
        }
        if matches!(control, Control::Stop) {
            let status = self.stop_inner().await?;
            return Ok(ControlReply {
                status,
                message: "Phone turned off.".into(),
                path: None,
            });
        }
        let (tools, udid) = self.running()?;
        let mut path = None;
        let message = match control {
            Control::Fold { folded } => {
                if self.state().extra.displays < 2 {
                    return Err("This simulator has no folding display.".into());
                }
                self.pose(&tools, &udid, Some(folded), None).await?;
                if folded {
                    "Phone folded."
                } else {
                    "Phone unfolded."
                }
                .into()
            }
            Control::Rotate { orientation } => {
                self.pose(&tools, &udid, None, Some(orientation)).await?;
                "Orientation updated.".into()
            }
            Control::Appearance { value } => {
                simctl(
                    &tools.xcrun,
                    &["ui", &udid, "appearance", &value],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                let read = simctl(
                    &tools.xcrun,
                    &["ui", &udid, "appearance"],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                self.state().extra.appearance = Some(read.clone());
                format!("Appearance: {read}.")
            }
            Control::TextSize { value } => {
                simctl(
                    &tools.xcrun,
                    &["ui", &udid, "content_size", &value],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                let read = simctl(
                    &tools.xcrun,
                    &["ui", &udid, "content_size"],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                self.state().extra.text_size = Some(read.clone());
                format!("Text size: {read}.")
            }
            Control::Contrast { enabled } => {
                simctl(
                    &tools.xcrun,
                    &[
                        "ui",
                        &udid,
                        "increase_contrast",
                        if enabled { "enabled" } else { "disabled" },
                    ],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                let read = simctl(
                    &tools.xcrun,
                    &["ui", &udid, "increase_contrast"],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                self.state().extra.contrast = match read.as_str() {
                    "enabled" => Some(true),
                    "disabled" => Some(false),
                    _ => None,
                };
                format!("Contrast: {read}.")
            }
            Control::StatusBar { clean } => {
                let args = if clean {
                    vec![
                        "status_bar",
                        &udid,
                        "override",
                        "--time",
                        "9:41",
                        "--dataNetwork",
                        "wifi",
                        "--wifiMode",
                        "active",
                        "--wifiBars",
                        "3",
                        "--batteryState",
                        "charged",
                        "--batteryLevel",
                        "100",
                    ]
                } else {
                    vec!["status_bar", &udid, "clear"]
                };
                simctl(&tools.xcrun, &args, axe::SIMCTL_LIMIT).await?;
                "Status bar updated.".into()
            }
            Control::Screenshot => {
                self.ready()?;
                let (file, geometry) = self.capture_path("png").await?;
                let display = format!("--display={}", geometry.display);
                simctl(
                    &tools.xcrun,
                    &[
                        "io",
                        &udid,
                        "screenshot",
                        &display,
                        "--type=png",
                        file.to_str().ok_or("Invalid capture path")?,
                    ],
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                path = Some(file.to_string_lossy().into_owned());
                self.state().extra.last_capture = path.clone();
                "Screenshot saved.".into()
            }
            Control::Recording { active: false } => {
                path = self.stop_recording().await?;
                "Recording stopped.".into()
            }
            Control::Recording { active: true } => {
                self.ready()?;
                if self.state().extra.recording.is_some() {
                    return Err("A recording is already running.".into());
                }
                let (file, geometry) = self.capture_path("mov").await?;
                let mut child = tokio::process::Command::new(&tools.xcrun)
                    .args([
                        "simctl",
                        "io",
                        &udid,
                        "recordVideo",
                        "--codec=h264",
                        &format!("--display={}", geometry.display),
                    ])
                    .arg(&file)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                let mut lines =
                    BufReader::new(child.stderr.take().ok_or("No recording status")?).lines();
                tokio::time::timeout(Duration::from_secs(12), async {
                    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
                        if line.contains("Recording started") {
                            return Ok(());
                        }
                    }
                    Err("The simulator could not start recording.".to_string())
                })
                .await
                .map_err(|_| "Recording did not start in time.")??;
                // Drain stderr so a long recording cannot block on a full pipe.
                self.runtime.spawn(async move {
                    while lines.next_line().await.ok().flatten().is_some() {}
                });
                let saved = file.to_string_lossy().into_owned();
                self.state().extra.recording = Some(Recording {
                    child,
                    path: saved.clone(),
                });
                let expected = self.geometry();
                let me = self.me.clone();
                self.runtime.spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let Some(phone) = me.upgrade() else { break };
                        if phone
                            .state()
                            .extra
                            .recording
                            .as_ref()
                            .is_none_or(|r| r.path != saved)
                        {
                            break;
                        }
                        let current = phone.geometry();
                        if recording_geometry_changed(&expected, &current) {
                            let _turn = phone.actions.lock().await;
                            if phone
                                .state()
                                .extra
                                .recording
                                .as_ref()
                                .is_some_and(|r| r.path == saved)
                            {
                                if let Err(error) = phone.stop_recording().await {
                                    phone.state().problem = Some(error);
                                }
                            }
                            break;
                        }
                    }
                });
                "Recording started.".into()
            }
            Control::Volume { direction } => {
                let usage = if direction == "up" { 0xe9 } else { 0xea };
                self.hid(
                    &tools.xcrun,
                    &udid,
                    &format!("key 12 {usage} 1\nkey 12 {usage} 0"),
                )
                .await?;
                format!("Volume {direction}.")
            }
            Control::Biometric { matched } => {
                axe::run_tool(
                    &tools.xcrun,
                    &[
                        "devicectl",
                        "device",
                        "simulate",
                        "biometrics",
                        "--device",
                        &udid,
                        if matched { "--success" } else { "--failure" },
                    ]
                    .map(String::from),
                    None,
                    axe::SIMCTL_LIMIT,
                )
                .await?;
                "Biometric event sent. Requires an enrolled device and an active prompt.".into()
            }
            Control::Location {
                latitude,
                longitude,
            } => {
                match (latitude, longitude) {
                    (Some(a), Some(b)) => {
                        simctl(
                            &tools.xcrun,
                            &["location", &udid, "set", &format!("{a},{b}")],
                            axe::SIMCTL_LIMIT,
                        )
                        .await?;
                    }
                    _ => {
                        simctl(
                            &tools.xcrun,
                            &["location", &udid, "clear"],
                            axe::SIMCTL_LIMIT,
                        )
                        .await?;
                    }
                }
                "Simulated location updated.".into()
            }
            Control::SelectDevice { .. } | Control::Stop => unreachable!(),
        };
        Ok(ControlReply {
            status: self.status(),
            message,
            path,
        })
    }

    pub(super) async fn pose(
        &self,
        tools: &Tools,
        udid: &str,
        folded: Option<bool>,
        orientation: Option<u32>,
    ) -> Result<(), String> {
        self.running()?;
        self.stop_recording().await?;
        let old = self.geometry();
        let listing = simctl(&tools.xcrun, &["io", udid, "enumerate"], axe::SIMCTL_LIMIT).await?;
        let displays = screens::parse(&listing);
        let requested_display = folded
            .map(|folded| {
                if folded {
                    displays.first()
                } else {
                    displays.last()
                }
            })
            .flatten()
            .map(|s| s.id);
        let recovery_display = { let state = self.state(); if state.extra.unconfirmed { state.extra.preferred_display } else { None } };
        let expected_display = requested_display.or(recovery_display).or(Some(old.display));
        let stream = {
            let mut s = self.state();
            s.extra.preferred_display = expected_display;
            s.extra.transitioning = true;
            s.extra.unconfirmed = false;
            s.extra.generation += 1;
            s.problem = None;
            s.stream.take()
        };
        if let Some(stream) = stream {
            stream.abort();
            let _ = stream.await;
        }
        *locked(&self.frame) = None;
        let result = async {
            if let Some(folded) = folded {
                self.hid(
                    &tools.xcrun,
                    udid,
                    if folded { "sweep 180 0 600" } else { "sweep 0 180 600" },
                )
                .await?;
            } else if let Some(value) = orientation {
                let physical = orientation_event(expected_display.unwrap_or(old.display), displays.len() > 1, value);
                if displays.len() > 1 {
                    self.hid(
                        &tools.xcrun,
                        udid,
                        &format!(
                            "orientation {}",
                            physical
                        ),
                    )
                    .await?;
                } else {
                    let value = [
                        "portrait",
                        "portraitUpsideDown",
                        "landscapeLeft",
                        "landscapeRight",
                    ][(value - 1) as usize];
                    axe::run_tool(
                        &tools.xcrun,
                        &[
                            "devicectl",
                            "device",
                            "orientation",
                            "set",
                            "--device",
                            udid,
                            value,
                        ]
                        .map(String::from),
                        None,
                        axe::SIMCTL_LIMIT,
                    )
                    .await?;
                }
                // Apps such as the folded Home screen can keep their UI in
                // portrait after a real rotation. Confirm the hardware pose,
                // then use the actual framebuffer orientation for touch input.
                confirm_orientation(tools, udid, physical).await?;
                self.state().extra.physical_orientation = Some(physical);
            }
            Ok::<(), String>(())
        }
        .await;
        self.resume_stream(tools, udid, expected_display);
        let result = match result {
            Err(e) => Err(e),
            Ok(()) => tokio::time::timeout(Duration::from_secs(25), async {
                let mut last = 0;
                let mut stable = 0;
                loop {
                    let frame = locked(&self.frame).clone();
                    if let Some(f) = frame.filter(|f| f.seq > last) {
                        last = f.seq;
                        let correct = f.screen.as_ref().is_some_and(|s| expected_display.is_none_or(|id| s.id == id));
                        let visible = image::load_from_memory(&f.jpeg).is_ok_and(|i| screens::visible(&i));
                        if correct && visible { stable += 1; } else { stable = 0; }
                        if stable >= 2 { break }
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }).await.map_err(|_| format!("Couldn't confirm the new display (previously display {}). Check the Phone picture and try again.", old.display)),
        };
        {
            let mut s = self.state();
            s.extra.transitioning = false;
            s.extra.unconfirmed = result.is_err();
            s.problem = result.as_ref().err().cloned();
        }
        result
    }

    pub(super) fn resume_stream(&self, tools: &Tools, udid: &str, preferred: Option<u32>) {
        self.state().stream = Some(self.runtime.spawn(screens::stream_preferred(
            tools.xcrun.clone(),
            udid.into(),
            self.frame.clone(),
            self.seq.clone(),
            preferred,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn capture_metadata_comes_from_one_frame_during_a_panel_switch() {
        let data = std::env::temp_dir().join(format!("deck-capture-snapshot-{}", std::process::id()));
        let phone = Phone::new(data.clone(), tokio::runtime::Handle::current());
        let frame = |id, width, height| Frame {
            seq: id as u64, jpeg: vec![], width: width / 2, height: height / 2,
            screen: Some(screens::Screen { id, pixel_width: width, pixel_height: height, ..Default::default() }),
        };
        *locked(&phone.frame) = Some(frame(1, 100, 200));
        let mut capture = Box::pin(phone.capture_path("png"));
        assert!(futures::poll!(capture.as_mut()).is_pending());
        *locked(&phone.frame) = Some(frame(3, 300, 200));
        let (path, geometry) = capture.await.unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("phone-display-1-100x200-") || name.starts_with("phone-display-3-300x200-"), "mixed capture metadata: {name}");
        assert!(name.starts_with(&format!("phone-display-{}-", geometry.display)));
        std::fs::remove_dir_all(data).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn native_hid_keeps_one_service_alive_across_commands_and_closes_on_stop() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("deck-hid-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("fake-xcrun");
        std::fs::write(&program, "#!/bin/sh\nwhile read line; do echo OK; done\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut session = HidSession::spawn(&program, "U", Path::new("helper")).unwrap();
        let pid = session.child.id();
        session.send("angle 0").await.unwrap();
        session.send("angle 180").await.unwrap();
        assert_eq!(session.child.id(), pid);
        assert!(session.child.try_wait().unwrap().is_none());
        drop(session.input);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), session.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn duo_inner_rotation_converts_ui_orientation_to_the_physical_hid_enum() {
        assert_eq!(orientation_event(3, true, 1), 3);
        assert_eq!(orientation_event(3, true, 3), 1);
        assert_eq!(orientation_event(3, true, 4), 2);
        assert_eq!(orientation_event(1, true, 3), 3);
        for display in [1, 3] {
            for orientation in 1..=4 {
                assert_eq!(orientation_event(display, true, orientation_event(display, true, orientation)), orientation);
            }
        }
    }
    #[test]
    fn rotation_readback_uses_hardware_pose_even_when_the_app_keeps_portrait_ui() {
        assert_eq!(physical_orientation_of(r#"{"result":{"deviceOrientation":"landscapeLeft","deviceOrientationNonFlat":"landscapeLeft"}}"#), Some(3));
        assert_eq!(physical_orientation_of(r#"{"result":{"deviceOrientation":"portraitUpsideDown"}}"#), Some(2));
        assert_eq!(physical_orientation_of(r#"{"result":{"deviceOrientation":"faceUp","deviceOrientationNonFlat":"landscapeRight"}}"#), Some(4));
        assert_eq!(physical_orientation_of(r#"{"result":{"deviceOrientation":"unknown"}}"#), None);
        assert_eq!(physical_orientation_of("bad json"), None);
    }
    #[test]
    fn capture_dropout_does_not_stop_a_recording_but_a_valid_rotation_does() {
        let expected = Geometry {
            generation: 1,
            display: 3,
            orientation: 3,
            width: 1426,
            height: 1003,
        };
        assert!(!recording_geometry_changed(
            &expected,
            &Geometry {
                width: 0,
                height: 0,
                display: 1,
                ..expected.clone()
            }
        ));
        assert!(recording_geometry_changed(
            &expected,
            &Geometry {
                orientation: 1,
                width: 1003,
                height: 1426,
                ..expected.clone()
            }
        ));
    }
    #[test]
    fn duo_hardware_buttons_use_native_consumer_usages() {
        assert_eq!(hardware_usage(HwButton::Home), 0x40);
        assert_eq!(hardware_usage(HwButton::Lock), 0x30);
    }
    #[test]
    fn invalid_controls_are_rejected_before_the_simulator_is_touched() {
        for control in [
            Control::Rotate { orientation: 9 },
            Control::Appearance {
                value: "auto".into(),
            },
            Control::TextSize {
                value: "huge".into(),
            },
            Control::Location {
                latitude: Some(91.0),
                longitude: Some(0.0),
            },
            Control::Location {
                latitude: Some(f64::NAN),
                longitude: Some(0.0),
            },
            Control::Location {
                latitude: None,
                longitude: Some(0.0),
            },
        ] {
            assert!(validate(&control).is_err(), "{control:?}");
        }
        assert!(validate(&Control::Location {
            latitude: None,
            longitude: None
        })
        .is_ok());
    }
    #[test]
    fn frames_from_an_old_display_or_pose_cannot_receive_input() {
        let a = Geometry {
            generation: 1,
            display: 1,
            orientation: 1,
            width: 699,
            height: 1017,
        };
        assert!(check_geometry(Some(&a), &a).is_ok());
        for b in [
            Geometry {
                generation: 2,
                ..a.clone()
            },
            Geometry {
                display: 3,
                ..a.clone()
            },
            Geometry {
                orientation: 3,
                ..a.clone()
            },
        ] {
            assert!(check_geometry(Some(&a), &b).is_err());
        }
    }
}
