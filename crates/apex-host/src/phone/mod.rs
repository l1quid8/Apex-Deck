//! The shared phone: one headless iOS simulator per data folder, its live
//! picture, and turn-taking between the person and the bots.

pub mod controls;
pub mod coords;
pub mod screens;
pub mod lock;
pub mod types;
pub mod axe;
pub mod device;
pub mod install;
pub mod guide;
pub use types::*;
pub use lock::{BotId, HolderView};

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;

use device::SavedDevice;
use lock::DriverLock;

const XCRUN: &str = "/usr/bin/xcrun";
const OFF: &str = "The phone is off. Run phone start, or turn it on in the Phone tab.";
const NO_PICTURE: &str = "The phone has no picture yet. Try again in a moment.";
const UNREADABLE: &str = "The phone started but its screen couldn't be read. Try Turn off, then Turn on.";
const NOT_MADE: &str = "The phone's simulator couldn't be made. Try again.";
const STILL_STARTING: &str = "Still turning on. Run phone status in a minute.";
const WEB_NOTE: &str = "Web page content is not listed. Use look, then what X Y.";
const NO_ELEMENTS: &str = "No named buttons or fields on this screen.";
/// A bot's `phone wait` lasts at most this long, checking this often.
const WAIT_MS: u64 = 100_000;
const WAIT_EVERY: Duration = Duration::from_millis(250);
/// A bot's `phone start` waits at most this long for the phone to come on, checking this often.
const START_MS: u64 = 110_000;
const START_EVERY: Duration = Duration::from_millis(500);
/// Reading the screen size while turning on: how many tries, and the pause between them.
const MEASURE_TRIES: u32 = 5;
const MEASURE_GAP: Duration = Duration::from_secs(3);
const STREAM_CHUNK: usize = 64 * 1024;
const STREAM_RETRY: Duration = Duration::from_secs(1);

/// The programs that drive the phone.
#[derive(Debug, Clone)]
pub struct Tools {
    pub axe: PathBuf,
    pub xcrun: PathBuf,
}

/// The latest screen picture. `seq` goes up by one with each picture.
#[derive(Debug, Clone)]
pub struct Frame {
    pub screen: Option<screens::Screen>,
    pub seq: u64,
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Power {
    Off,
    Starting,
    On,
}

struct State {
    extra: controls::Extra,
    touch: Option<(PathBuf, String)>,
    power: Power,
    device: Option<SavedDevice>,
    tools: Option<Tools>,
    lock: DriverLock,
    problem: Option<String>,
    stream: Option<tokio::task::JoinHandle<()>>,
    /// How many times `start` has begun turning the phone on. A start that
    /// was turned off midway sees a newer number, or `Off`, and gives up.
    starts: u64,
}

pub struct Phone {
    data: PathBuf,
    runtime: tokio::runtime::Handle,
    clock: Instant,
    /// This phone's own `Arc`, so a bot's `start` can spawn the turning-on task.
    me: Weak<Phone>,
    state: Mutex<State>,
    frame: Arc<Mutex<Option<Frame>>>,
    /// The latest picture number handed out. `stop` doesn't reset it, so a
    /// viewer that remembers a number never mistakes a new picture for it.
    seq: Arc<AtomicU64>,
    /// Held around every input, so the person's and the bots' never interleave.
    actions: tokio::sync::Mutex<()>,
    /// Held while the simulator shuts down, so a quick Turn on waits for it before booting.
    shutting_down: tokio::sync::Mutex<()>,
    /// A cancelled start must finish before the next start uses the tools or device.
    starting: tokio::sync::Mutex<()>,
}

/// What an input needs: the phone on, its screen size in points, and a picture.
struct Ready {
    screen: Option<screens::Screen>,
    touch: Option<(PathBuf, String)>,
    tools: Tools,
    udid: String,
    points: (f64, f64),
    width: u32,
    height: u32,
}

/// Finish a human input even when its request is cancelled while queued.
struct HumanInput<'a>(&'a Phone, u64);
impl Drop for HumanInput<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state();
        if state.starts == self.1 { state.lock.end_human_input(self.0.now()); }
    }
}

impl Ready {
    /// Picture pixels per point.
    fn scale(&self) -> f64 {
        self.width as f64 / self.points.0
    }

    /// A spot in the picture, in points. Spots outside the picture are refused.
    fn point(&self, x: u32, y: u32) -> Result<(f64, f64), String> {
        if x >= self.width || y >= self.height {
            return Err(format!("{x},{y} is outside the picture ({}×{}).", self.width, self.height));
        }
        let scale = self.scale();
        Ok((coords::to_points(x, scale), coords::to_points(y, scale)))
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The lowercase name a bot types for a key or button, such as `enter` or `home`.
fn wire_name(value: impl serde::Serialize) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

async fn simctl(xcrun: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let args: Vec<String> = std::iter::once("simctl").chain(args.iter().copied()).map(String::from).collect();
    axe::run_tool(xcrun, &args, None, limit).await
}

impl Phone {
    pub fn new(data: PathBuf, runtime: tokio::runtime::Handle) -> Arc<Phone> {
        Self::build(data, runtime, None)
    }

    /// A phone that uses these tools instead of downloading AXe (for tests).
    pub fn with_tools(data: PathBuf, runtime: tokio::runtime::Handle, tools: Tools) -> Arc<Phone> {
        Self::build(data, runtime, Some(tools))
    }

    fn build(data: PathBuf, runtime: tokio::runtime::Handle, tools: Option<Tools>) -> Arc<Phone> {
        let device = device::load(&data.join("phone"));
        Arc::new_cyclic(|me| Phone {
            runtime,
            clock: Instant::now(),
            me: me.clone(),
            state: Mutex::new(State {
                extra: controls::Extra::default(),
                touch: None,
                power: Power::Off,
                device,
                tools,
                lock: DriverLock::default(),
                problem: None,
                stream: None,
                starts: 0,
            }),
            frame: Arc::new(Mutex::new(None)),
            seq: Arc::new(AtomicU64::new(0)),
            actions: tokio::sync::Mutex::new(()),
            shutting_down: tokio::sync::Mutex::new(()),
            starting: tokio::sync::Mutex::new(()),
            data,
        })
    }

    fn now(&self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }

    fn state(&self) -> MutexGuard<'_, State> {
        locked(&self.state)
    }

    pub fn status(&self) -> Status { self.snapshot().0 }

    /// One state/frame snapshot: the image's geometry can never come from a
    /// newer capture or device generation than the image being handed out.
    fn snapshot(&self) -> (Status, Option<Frame>) {
        let mut state = self.state();
        let frame = locked(&self.frame).clone();
        let geometry = controls::geometry_of(frame.as_ref(), state.extra.generation);
        let (width, height) = (geometry.width, geometry.height);
        let screen = frame.as_ref().and_then(|f| f.screen.as_ref());
        let (pw, ph, scale) = screen.map_or((width, height, 1), |s| (s.pixel_width, s.pixel_height, s.scale.max(1)));
        let status = Status {
            on: state.power == Power::On,
            starting: state.power == Power::Starting,
            device: state.device.as_ref().map(|d| d.name.clone()),
            udid: state.device.as_ref().map(|d| d.udid.clone()),
            holder: state.lock.view(self.now()), width, height,
            pixel_width: pw, pixel_height: ph, point_width: pw as f64 / scale as f64, point_height: ph as f64 / scale as f64,
            transitioning: state.extra.transitioning,
            input_ready: frame.is_some() && !state.extra.transitioning && !state.extra.unconfirmed,
            geometry,
            orientation: state.extra.physical_orientation.map(|p| controls::orientation_event(screen.map_or(1, |s| s.id), state.extra.displays > 1, p)),
            displays: state.extra.displays,
            model: state.extra.model.clone(), runtime: state.extra.runtime.clone(),
            appearance: state.extra.appearance.clone(), text_size: state.extra.text_size.clone(), contrast: state.extra.contrast,
            recording: state.extra.recording.as_ref().map(|r| r.path.clone()), last_capture: state.extra.last_capture.clone(),
            problem: state.problem.clone().or_else(|| (state.power == Power::On && width == 0).then(|| "Waiting for a live phone picture…".into())),
        };
        (status, frame)
    }

    pub fn view(&self, since: u64) -> View {
        let (status, latest) = self.snapshot();
        let frame = latest.filter(|f| f.seq != since && !status.transitioning).map(|f| FrameView {
            seq: f.seq, image: to_base64(&f.jpeg), width: f.width, height: f.height,
        });
        View { status, frame }
    }

    /// Starts turning the phone on in the background. Does nothing while it's starting or on.
    pub fn start(self: &Arc<Self>) -> Status {
        let begun = {
            let mut state = self.state();
            if state.power == Power::Off {
                state.extra.unconfirmed = false;
                state.power = Power::Starting;
                state.problem = None;
                state.starts += 1;
                Some(state.starts)
            } else {
                None
            }
        };
        if let Some(start) = begun {
            self.runtime.spawn(Arc::clone(self).turn_on(start));
        }
        self.status()
    }

    /// Whether start number `start` is still the one turning the phone on.
    fn is_current(&self, start: u64) -> bool {
        let state = self.state();
        state.power == Power::Starting && state.starts == start
    }

    async fn turn_on(self: Arc<Self>, start: u64) {
        let _starting = self.starting.lock().await;
        if !self.is_current(start) { return; }
        let result = self.bring_up(start).await;
        let leftover = {
            let mut state = self.state();
            if state.power == Power::Starting && state.starts == start {
                match result {
                    Ok(Some((axe, udid))) => {
                        let frame = Arc::clone(&self.frame);
                        let seq = Arc::clone(&self.seq);
                        state.stream = Some(if state.extra.displays > 0 {
                            self.runtime.spawn(screens::stream(state.tools.as_ref().unwrap().xcrun.clone(), udid, frame, seq))
                        } else { self.runtime.spawn(stream(axe, udid, frame, seq)) });
                        state.power = Power::On;
                    }
                    // Not reached: `None` means a stop or a newer start came first.
                    Ok(None) => state.power = Power::Off,
                    Err(problem) => {
                        state.power = Power::Off;
                        state.problem = Some(problem);
                    }
                }
                None
            } else if state.power == Power::Off {
                // Turned off while starting: don't leave the simulator running.
                state.device.as_ref().map(|d| d.udid.clone())
            } else {
                // A newer start owns the simulator now.
                None
            }
        };
        if let Some(udid) = leftover {
            let _shutting = self.shutting_down.lock().await;
            // A new start may have arrived while the shutdown barrier was busy.
            let still_off = { let state = self.state(); state.power == Power::Off && state.starts == start };
            if still_off { let _ = self.shut_down_locked(&udid).await; }
        }
    }

    /// The steps of turning on. Gives the picture tool and simulator to stream
    /// from, or `None` when the phone was turned off midway.
    async fn bring_up(&self, start: u64) -> Result<Option<(PathBuf, String)>, String> {
        let tools = self.tools().await?;
        let dir = self.data.join("phone");
        let mut saved = self.find_device(&tools, &dir).await?;
        self.state().device = Some(saved.clone());
        // Resolve the actual model/runtime even for a legacy saved Duo device.
        if let Ok(listed) = simctl(&tools.xcrun, &["list", "-j", "devices"], axe::SIMCTL_LIMIT).await {
            if let Ok(listed) = serde_json::from_str::<serde_json::Value>(&listed) {
                let found = listed["devices"].as_object().and_then(|groups| groups.iter().find_map(|(runtime, devices)| devices.as_array()?.iter().find(|d| d["udid"] == saved.udid).and_then(|d| d["deviceTypeIdentifier"].as_str().map(|kind| (runtime.clone(), kind.to_string())))));
                if let Some((runtime, kind)) = found {
                    if let Ok(choices) = self.devices().await {
                        if let Some(choice) = choices.into_iter().find(|d| d.runtime == runtime && d.device_type == kind) { let mut s = self.state(); s.extra.model = Some(choice.model); s.extra.runtime = Some(choice.version); }
                    }
                }
            }
        }
        // Right after Turn off, wait for the shutdown to finish before booting.
        drop(self.shutting_down.lock().await);
        if !self.is_current(start) {
            return Ok(None);
        }
        simctl(&tools.xcrun, &["bootstatus", &saved.udid, "-b"], axe::BOOT_LIMIT).await?;
        let listing = simctl(&tools.xcrun, &["io", &saved.udid, "enumerate"], axe::SIMCTL_LIMIT).await?;
        let touch = if screens::parse(&listing).len() > 1 { Some(install::ensure_touch(&self.data).await?) } else { None };
        { let mut s = self.state(); s.touch = touch; s.extra.displays = screens::parse(&listing).len(); }
        for (option, field) in [("appearance", 0), ("content_size", 1), ("increase_contrast", 2)] {
            if let Ok(value) = simctl(&tools.xcrun, &["ui", &saved.udid, option], axe::SIMCTL_LIMIT).await {
                let mut s = self.state();
                match field { 0 => s.extra.appearance = Some(value), 1 => s.extra.text_size = Some(value), _ => s.extra.contrast = match value.as_str() { "enabled" => Some(true), "disabled" => Some(false), _ => None } }
            }
        }
        if saved.points.is_none() {
            let mut points = screens::panel_points(&listing);
            if points.is_some() { saved.points = points; }
            if saved.points.is_none() {
            for tried in 0..MEASURE_TRIES {
                if tried > 0 {
                    tokio::time::sleep(MEASURE_GAP).await;
                }
                if !self.is_current(start) {
                    return Ok(None);
                }
                let tree = axe::run_tool(&tools.axe, &axe::describe_args(&saved.udid, None), None, axe::DESCRIBE_LIMIT).await;
                points = tree.ok().as_deref().and_then(device::root_points);
                if points.is_some() {
                    break;
                }
            }
            saved.points = Some(points.ok_or(UNREADABLE)?);
            }
            device::save(&dir, &saved)?;
            self.state().device = Some(saved.clone());
        }
        Ok(Some((tools.axe, saved.udid)))
    }

    async fn tools(&self) -> Result<Tools, String> {
        let known = self.state().tools.clone();
        if let Some(tools) = known {
            return Ok(tools);
        }
        let tools = Tools { axe: install::ensure(&self.data).await?, xcrun: PathBuf::from(XCRUN) };
        self.state().tools = Some(tools.clone());
        Ok(tools)
    }

    /// Deck's simulator for this data folder: the saved one if it still
    /// exists, else one with its name, else a new one. Saved when it changes.
    async fn find_device(&self, tools: &Tools, dir: &Path) -> Result<SavedDevice, String> {
        let name = device::load(dir).map(|d| d.name).unwrap_or_else(|| device::device_name(&self.data));
        let listed = simctl(&tools.xcrun, &["list", "-j", "devices"], axe::SIMCTL_LIMIT).await?;
        let found = device::find_udid(&listed, &name);
        if let Some(saved) = device::load(dir) {
            if found.as_deref() == Some(saved.udid.as_str()) {
                return Ok(saved);
            }
        }
        let udid = match found {
            Some(udid) => udid,
            None => {
                let kinds = simctl(&tools.xcrun, &["list", "-j", "runtimes", "devicetypes"], axe::SIMCTL_LIMIT).await?;
                let (runtime, device_type) = device::pick(&kinds)?;
                let udid = simctl(&tools.xcrun, &["create", &name, &device_type, &runtime], axe::SIMCTL_LIMIT).await?;
                if udid.is_empty() {
                    return Err(NOT_MADE.into());
                }
                udid
            }
        };
        let saved = SavedDevice { udid, name, points: None };
        device::save(dir, &saved)?;
        Ok(saved)
    }

    /// `simctl shutdown`, counting an already shut down simulator as done.
    async fn shut_down_locked(&self, udid: &str) -> Result<(), String> {
        let xcrun = self.state().tools.as_ref().map_or_else(|| PathBuf::from(XCRUN), |t| t.xcrun.clone());
        match simctl(&xcrun, &["shutdown", udid], axe::SIMCTL_LIMIT).await {
            Err(problem) if !problem.contains("current state: Shutdown") => Err(problem),
            _ => Ok(()),
        }
    }

    /// Turns the phone off: ends the picture, shuts the simulator down and frees the phone.
    pub async fn stop(&self) -> Result<Status, String> {
        let generation = { let mut s = self.state(); s.lock.begin_human_input(self.now()); s.starts };
        let _human = HumanInput(self, generation);
        let _turn = self.actions.lock().await;
        self.stop_inner().await
    }

    async fn stop_inner(&self) -> Result<Status, String> {
        let recording_result = self.stop_recording().await;
        self.stop_hid().await;
        // Reserve shutdown before publishing Off, so a new start cannot boot
        // between this stop's stream cleanup and simulator shutdown.
        let _shutting = self.shutting_down.lock().await;
        // Off first, so a start still in progress gives up instead of turning it on.
        let (stream, udid) = {
            let mut state = self.state();
            state.power = Power::Off;
            state.extra.transitioning = false;
            state.extra.unconfirmed = false;
            state.extra.preferred_display = None;
            state.extra.physical_orientation = None;
            state.extra.generation += 1;
            state.lock.reset();
            (state.stream.take(), state.device.as_ref().map(|d| d.udid.clone()))
        };
        if let Some(stream) = stream {
            stream.abort();
            // Wait until it has really ended, so it can't store a picture after the clear below.
            let _ = stream.await;
        }
        *locked(&self.frame) = None;
        let shutdown_result = if let Some(udid) = udid {
            self.shut_down_locked(&udid).await
        } else {
            Ok(())
        };
        match (recording_result, shutdown_result) {
            (Err(recording), Err(shutdown)) => return Err(format!("{recording} Also, simulator shutdown failed: {shutdown}")),
            (Err(problem), _) | (_, Err(problem)) => return Err(problem),
            (Ok(_), Ok(())) => {}
        }
        Ok(self.status())
    }

    /// The tools and simulator, when the phone is on.
    fn running(&self) -> Result<(Tools, String), String> {
        let state = self.state();
        match (state.power, &state.tools, &state.device) {
            (Power::On, Some(tools), Some(device)) => Ok((tools.clone(), device.udid.clone())),
            _ => Err(OFF.into()),
        }
    }

    fn ready(&self) -> Result<Ready, String> { self.ready_at(None) }

    fn ready_at(&self, expected: Option<&Geometry>) -> Result<Ready, String> {
        let state = self.state();
        if state.extra.transitioning { return Err("The phone is changing displays. Wait for the new picture.".into()); }
        if state.extra.unconfirmed { return Err("The display transition is unconfirmed. Use Fold, Rotate, Home or power controls to recover before tapping.".into()); }
        let (tools, udid, points) = match (state.power, &state.tools, &state.device) {
            (Power::On, Some(tools), Some(SavedDevice { udid, points: Some(points), .. })) => (tools.clone(), udid.clone(), *points),
            _ => return Err(OFF.into()),
        };
        let frame = locked(&self.frame).clone().ok_or(NO_PICTURE)?;
        controls::check_geometry(expected, &controls::geometry_of(Some(&frame), state.extra.generation))?;
        let screen = frame.screen;
        let points = screen.as_ref().filter(|s| s.pixel_width > 0 && s.scale > 0).map_or(points, |s| (s.pixel_width as f64 / s.scale as f64, s.pixel_height as f64 / s.scale as f64));
        Ok(Ready { tools, udid, points, width: frame.width, height: frame.height, screen, touch: state.touch.clone() })
    }

    /// Sends one input to the phone and says what was done.
    async fn act(&self, input: &Input) -> Result<String, String> { self.act_at(input, None).await }

    async fn act_at(&self, input: &Input, geometry: Option<&Geometry>) -> Result<String, String> {
        if let Input::Button { button } = input {
            let (tools, udid) = self.running()?;
            let duo = self.state().extra.displays > 1;
            if duo {
                let usage = controls::hardware_usage(*button);
                self.hid(&tools.xcrun, &udid, &format!("key 12 {usage} 1\nkey 12 {usage} 0")).await?;
            } else {
                axe::run_tool(&tools.axe, &axe::button_args(&udid, *button), None, axe::INPUT_LIMIT).await?;
            }
            let recover = self.state().extra.unconfirmed && matches!(button, HwButton::Home);
            if recover { self.pose(&tools, &udid, None, None).await?; }
            return Ok(format!("Pressed the {} button.", wire_name(button)));
        }
        let ready = self.ready_at(geometry)?;
        let udid = ready.udid.as_str();
        if let (Input::Type {text}, Some((program,developer))) = (input, &ready.touch) {
            axe::check_text(text)?;
            let args = vec![developer.clone(),udid.into(),"type".into()];
            axe::run_tool(program,&args,Some(text),axe::INPUT_LIMIT).await?;
            return Ok(format!("Typed {} characters.",text.len()));
        }
        if let (Input::Key {key}, Some((program,developer))) = (input, &ready.touch) {
            let args = vec![developer.clone(),udid.into(),"key".into(),key.hid().to_string()];
            axe::run_tool(program,&args,None,axe::INPUT_LIMIT).await?;
            return Ok(format!("Pressed {}.",wire_name(key)));
        }
        if let (Some(screen), Some((program,developer))) = (&ready.screen, &ready.touch) {
            let gesture = match input {
                Input::Tap { x,y } => Some((*x,*y,*x,*y,100)),
                Input::Swipe { x1,y1,x2,y2,ms } => Some((*x1,*y1,*x2,*y2,(*ms).clamp(100,1000))),
                _ => None,
            };
            if let Some((x1,y1,x2,y2,ms)) = gesture {
                ready.point(x1,y1)?; ready.point(x2,y2)?;
                let (sx,sy) = screens::touch_ratio(screen,x1 as f64/ready.width as f64,y1 as f64/ready.height as f64);
                let (ex,ey) = screens::touch_ratio(screen,x2 as f64/ready.width as f64,y2 as f64/ready.height as f64);
                let args = vec![developer.clone(),udid.into(),screen.id.to_string(),sx.to_string(),sy.to_string(),ex.to_string(),ey.to_string(),ms.to_string()];
                axe::run_tool(program,&args,None,axe::INPUT_LIMIT).await?;
                return Ok("Sent the gesture to the displayed phone screen.".into());
            }
        }
        let (args, stdin, done) = match input {
            Input::Tap { x, y } => {
                let (px, py) = ready.point(*x, *y)?;
                (axe::tap_args(udid, px, py), None, format!("Tapped {x},{y}."))
            }
            Input::Swipe { x1, y1, x2, y2, ms } => {
                let (from, to) = (ready.point(*x1, *y1)?, ready.point(*x2, *y2)?);
                (axe::swipe_args(udid, from, to, *ms), None, format!("Swiped from {x1},{y1} to {x2},{y2}."))
            }
            Input::Type { text } => {
                axe::check_text(text)?;
                (axe::type_args(udid), Some(text.as_str()), format!("Typed {} characters.", text.len()))
            }
            Input::Key { key } => (axe::key_args(udid, *key), None, format!("Pressed {}.", wire_name(key))),
            Input::Button { button } => (axe::button_args(udid, *button), None, format!("Pressed the {} button.", wire_name(button))),
        };
        axe::run_tool(&ready.tools.axe, &args, stdin, axe::INPUT_LIMIT).await?;
        Ok(done)
    }

    /// The person's tap, swipe, typing, key or button. The person always gets the phone.
    pub async fn human(&self, input: Input) -> Result<Status, String> { self.human_at(input, None).await }

    pub async fn human_at(&self, input: Input, geometry: Option<Geometry>) -> Result<Status, String> {
        self.running()?;
        let now = self.now();
        let generation = {
            let mut state = self.state();
            state.lock.begin_human_input(now);
            state.starts
        };
        let _human = HumanInput(self, generation);
        let _turn = self.actions.lock().await;
        self.act_at(&input, geometry.as_ref()).await?;
        Ok(self.status())
    }

    /// The person is done for now: the bots may have the phone.
    pub fn give_back(&self) -> Status {
        let now = self.now();
        self.state().lock.give_back(now);
        self.status()
    }

    /// A chat message in `room` was queued behind a running turn.
    pub fn chat_queued(&self, room: &str) {
        self.state().lock.chat_queued(room);
    }

    /// One request from a bot. A busy phone is a `Wait` reply; `Err` is a problem to show the bot.
    pub async fn bot(&self, who: BotId, request: BotRequest) -> Result<BotReply, String> {
        use BotRequest as R;
        // Claim the phone only when this action can actually run. A person
        // taking over while it was queued must be able to refuse it.
        let _turn = if matches!(request, R::Control { .. } | R::Act { .. } | R::TapLabel { .. } | R::Launch { .. } | R::Open { .. }) {
            Some(self.actions.lock().await)
        } else { None };
        if matches!(request, R::Control { .. } | R::Act { .. } | R::TapLabel { .. } | R::Install { .. } | R::Launch { .. } | R::Open { .. }) {
            if !matches!(request, R::Control { control: Control::SelectDevice { .. } | Control::Stop }) { self.running()?; }
            let now = self.now();
            let turn = self.state().lock.bot_act(&who, now);
            if let Err(busy) = turn {
                return Ok(BotReply::wait(guide::busy_text(&busy)));
            }
        }
        match request {
            R::Devices => Ok(BotReply::ok(serde_json::to_string_pretty(&self.devices().await?).map_err(|e| e.to_string())?)),
            R::Control { control } => {
                let result = self.control(control).await?;
                Ok(BotReply::ok(format!("{}{}", result.message, result.path.map(|p| format!("\nSaved: {p}")).unwrap_or_default())))
            }
            R::Status => Ok(BotReply::ok(guide::status_text(&self.status()))),
            R::Start => self.bot_start().await,
            R::Look => self.look(),
            R::What { x, y } => self.what(x, y).await,
            R::Elements => self.elements().await,
            R::Act { input } => self.act(&input).await.map(BotReply::ok),
            R::TapLabel { text } => {
                let (tools, udid) = self.running()?;
                axe::run_tool(&tools.axe, &axe::tap_label_args(&udid, &text), None, axe::INPUT_LIMIT).await?;
                Ok(BotReply::ok(format!("Tapped \"{text}\".")))
            }
            R::Install { path } => {
                // Not under `actions`: an install can take minutes and doesn't touch the screen.
                let (tools, udid) = self.running()?;
                simctl(&tools.xcrun, &["install", &udid, &path], axe::INSTALL_LIMIT).await?;
                Ok(BotReply::ok(format!("Installed {path}.")))
            }
            R::Launch { bundle } => {
                let (tools, udid) = self.running()?;
                simctl(&tools.xcrun, &["launch", "--terminate-running-process", &udid, &bundle], axe::SIMCTL_LIMIT).await?;
                Ok(BotReply::ok(format!("Launched {bundle}.")))
            }
            R::Open { url } => {
                let (tools, udid) = self.running()?;
                simctl(&tools.xcrun, &["openurl", &udid, &url], axe::SIMCTL_LIMIT).await?;
                Ok(BotReply::ok(format!("Opened {url}.")))
            }
            R::Wait => Ok(self.wait_turn(&who).await),
            R::Done => {
                self.state().lock.bot_done(&who);
                Ok(BotReply::ok("Released the phone."))
            }
        }
    }

    async fn bot_start(&self) -> Result<BotReply, String> {
        if let Some(me) = self.me.upgrade() {
            me.start();
        }
        let began = self.now();
        loop {
            let status = self.status();
            if status.on && status.width > 0 && status.height > 0 {
                return Ok(BotReply::ok(guide::status_text(&status)));
            }
            if !status.on && !status.starting {
                if let Some(problem) = status.problem {
                    return Err(problem);
                }
                // Turned off by someone else meanwhile.
                return Ok(BotReply::ok(guide::status_text(&status)));
            }
            if self.now().saturating_sub(began) >= START_MS {
                return Ok(BotReply::ok(STILL_STARTING));
            }
            tokio::time::sleep(START_EVERY).await;
        }
    }

    fn look(&self) -> Result<BotReply, String> {
        self.ready()?;
        let now = self.now();
        let holder = self.state().lock.view(now);
        let latest = locked(&self.frame);
        let frame = latest.as_ref().ok_or(NO_PICTURE)?;
        let mut reply = BotReply::ok(format!(
            "Screen picture: {}×{} pixels. {}",
            frame.width,
            frame.height,
            guide::holder_text(&holder)
        ));
        reply.image = Some(to_base64(&frame.jpeg));
        reply.seq = Some(frame.seq);
        Ok(reply)
    }

    async fn what(&self, x: u32, y: u32) -> Result<BotReply, String> {
        let ready = self.ready()?;
        let point = ready.point(x, y)?;
        let json = axe::run_tool(&ready.tools.axe, &axe::describe_args(&ready.udid, Some(point)), None, axe::DESCRIBE_LIMIT).await?;
        Ok(BotReply::ok(axe::point_line(&json, ready.scale())?))
    }

    async fn elements(&self) -> Result<BotReply, String> {
        let ready = self.ready()?;
        let json = axe::run_tool(&ready.tools.axe, &axe::describe_args(&ready.udid, None), None, axe::DESCRIBE_LIMIT).await?;
        let lines = axe::element_lines(&json, ready.scale())?;
        if lines.is_empty() {
            return Ok(BotReply::ok(NO_ELEMENTS));
        }
        Ok(BotReply::ok(format!("{}\n{WEB_NOTE}", lines.join("\n"))))
    }

    /// Waits until the phone is this bot's to use, for at most `WAIT_MS`.
    async fn wait_turn(&self, who: &BotId) -> BotReply {
        let started = self.now();
        loop {
            let now = self.now();
            let outcome = self.state().lock.wait_outcome(who, started, now);
            if let Some(outcome) = outcome {
                return BotReply::ok(guide::wait_text(Some(&outcome)));
            }
            if now.saturating_sub(started) >= WAIT_MS {
                return BotReply::wait(guide::wait_text(None));
            }
            tokio::time::sleep(WAIT_EVERY).await;
        }
    }
}

impl Drop for Phone {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(stream) = state.stream.take() {
            stream.abort();
        }
    }
}

/// Keeps the latest screen picture in `frame`, starting the picture tool again whenever it stops.
async fn stream(axe: PathBuf, udid: String, frame: Arc<Mutex<Option<Frame>>>, seq: Arc<AtomicU64>) {
    loop {
        stream_once(&axe, &udid, &frame, &seq).await;
        *locked(&frame) = None;
        tokio::time::sleep(STREAM_RETRY).await;
    }
}

/// One run of `axe stream-video`, until its output ends or can't be read.
async fn stream_once(program: &Path, udid: &str, frame: &Mutex<Option<Frame>>, seq: &AtomicU64) {
    let spawned = tokio::process::Command::new(program)
        .args(axe::stream_args(udid))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = spawned else { return };
    if let Some(mut out) = child.stdout.take() {
        let mut reader = coords::FrameReader::default();
        let mut chunk = vec![0u8; STREAM_CHUNK];
        loop {
            let read = match tokio::time::timeout(Duration::from_secs(4), out.read(&mut chunk)).await {
                Ok(Ok(read)) if read > 0 => read,
                _ => break,
            };
            let Ok(jpegs) = reader.push(&chunk[..read]) else { break };
            for jpeg in jpegs {
                let Some((width, height)) = coords::jpeg_size(&jpeg) else { continue };
                let mut latest = locked(frame);
                let next = seq.fetch_add(1, Ordering::Relaxed) + 1;
                *latest = Some(Frame { seq: next, jpeg, width, height, screen: None });
            }
        }
    }
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A data folder with fake tools that log what they're asked.
    fn fake(name: &str) -> (PathBuf, Tools) {
        let dir = std::env::temp_dir().join(format!("apex-phone-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let device = device::device_name(&data);
        std::fs::write(bin.join("runtimes.json"), r#"{"runtimes":[{"identifier":"RT","platform":"iOS","version":"26.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"T","name":"iPhone 17 Pro","productFamily":"iPhone"}]}]}"#).unwrap();
        std::fs::write(bin.join("devices-after.json"), format!(r#"{{"devices":{{"RT":[{{"udid":"FAKE-UDID","name":"{device}"}}]}}}}"#)).unwrap();
        std::fs::write(bin.join("tree.json"), r#"[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874}}]"#).unwrap();
        std::fs::write(bin.join("frame.bin"), coords::framed(&coords::tiny_jpeg(603, 1311))).unwrap();
        let script = |file: &str, body: &str| {
            let path = bin.join(file);
            std::fs::write(&path, format!("#!/bin/sh\ndir=\"$(dirname \"$0\")\"\n{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let xcrun = script("xcrun", r#"echo "xcrun $*" >> "$dir/calls.log"
case "$*" in
  "simctl list -j runtimes devicetypes") cat "$dir/runtimes.json" ;;
  "simctl list -j devices") if [ -f "$dir/created" ]; then cat "$dir/devices-after.json"; else echo '{"devices":{}}'; fi ;;
  simctl\ create*) touch "$dir/created"; echo FAKE-UDID ;;
  *) : ;;
esac
"#);
        let axe = script("axe", r#"case "$1" in
  stream-video) cat "$dir/frame.bin"; exec sleep 30 ;;
  describe-ui) cat "$dir/tree.json" ;;
  type) echo "axe $* stdin=$(cat)" >> "$dir/calls.log" ;;
  *) echo "axe $*" >> "$dir/calls.log" ;;
esac
"#);
        (data, Tools { axe, xcrun })
    }

    fn calls(tools: &Tools) -> String {
        std::fs::read_to_string(tools.axe.parent().unwrap().join("calls.log")).unwrap_or_default()
    }

    async fn on(phone: &Arc<Phone>) {
        phone.start();
        for _ in 0..100 {
            if phone.status().on && phone.view(0).frame.is_some() { return; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("phone never came on: {:?}", phone.status().problem);
    }

    fn ann() -> BotId { BotId { room: "r1".into(), bot: "a".into(), name: "Ann".into() } }
    fn bo() -> BotId { BotId { room: "r1".into(), bot: "b".into(), name: "Bo".into() } }

    #[tokio::test]
    async fn selecting_the_legacy_model_reuses_its_existing_apps_and_data() {
        let (data, tools) = fake("adopt-legacy");
        let phone = Phone::with_tools(data.clone(), tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        let original = device::load(&data.join("phone")).unwrap();
        let listing = serde_json::json!({ "devices": { "RT": [{ "udid": original.udid, "name": original.name, "deviceTypeIdentifier": "T", "isAvailable": true }] } });
        std::fs::write(tools.xcrun.parent().unwrap().join("devices-after.json"), listing.to_string()).unwrap();
        phone.human_control(Control::SelectDevice { runtime: "RT".into(), device_type: "T".into() }).await.unwrap();
        on(&phone).await;
        assert_eq!(device::load(&data.join("phone")).unwrap().udid, original.udid);
        assert_eq!(device::load(&device::selection_dir(&data, "RT", "T")).unwrap().udid, original.udid);
        assert_eq!(calls(&tools).matches("xcrun simctl create").count(), 1);
    }

    #[tokio::test]
    async fn an_unconfirmed_transition_keeps_gestures_blocked() {
        let (data, tools) = fake("unconfirmed");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.state().extra.unconfirmed = true;
        assert!(!phone.status().input_ready);
        let error = phone.human(Input::Tap { x: 10, y: 10 }).await.unwrap_err();
        assert!(error.contains("unconfirmed"), "{error}");
    }

    #[tokio::test]
    async fn a_view_always_tags_its_picture_with_the_same_geometry() {
        let (data, tools) = fake("atomic-view");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        let stream = phone.state().stream.take().unwrap(); stream.abort(); let _ = stream.await;
        let updating = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let writer = { let frame = phone.frame.clone(); let updating = updating.clone(); std::thread::spawn(move || { let mut n = 1; while updating.load(Ordering::Relaxed) { n += 1; *locked(&frame) = Some(Frame { seq: n, jpeg: vec![1,2,3], width: if n % 2 == 0 { 600 } else { 900 }, height: 400, screen: None }); } }) };
        for _ in 0..2000 { let view = phone.view(0); let f = view.frame.unwrap(); assert_eq!(view.status.geometry.width, f.width); assert_eq!(view.status.width, f.width); }
        updating.store(false, Ordering::Relaxed); writer.join().unwrap();
    }

    #[tokio::test]
    async fn stale_human_geometry_is_refused_after_waiting_for_a_control() {
        let (data, tools) = fake("stale-human");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        let old = phone.geometry();
        phone.state().extra.generation += 1;
        let error = phone.human_at(Input::Tap { x: 10, y: 10 }, Some(old)).await.unwrap_err();
        assert!(error.contains("display changed"), "{error}");
        assert!(!calls(&tools).contains("axe tap"));
    }

    #[tokio::test]
    async fn native_controls_preserve_human_priority_and_surface_failures() {
        let (data, tools) = fake("control-priority");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Button { button: HwButton::Home }).await.unwrap();
        let reply = phone.bot(ann(), BotRequest::Control { control: Control::Appearance { value: "dark".into() } }).await.unwrap();
        assert_eq!(reply.code, ReplyCode::Wait);
        phone.give_back();
        let error = phone.human_control(Control::Fold { folded: true }).await.unwrap_err();
        assert!(error.contains("no folding display"));
        assert!(!phone.status().transitioning);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn turning_on_creates_boots_and_shows_the_screen() {
        let (data, tools) = fake("on");
        let phone = Phone::with_tools(data.clone(), tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        let view = phone.view(0);
        assert_eq!((view.frame.as_ref().unwrap().width, view.frame.as_ref().unwrap().height), (603, 1311));
        assert!(phone.view(view.frame.unwrap().seq).frame.is_none(), "an unchanged picture isn't sent again");
        assert_eq!(device::load(&data.join("phone")).unwrap().points, Some((402.0, 874.0)));
        let log = calls(&tools);
        assert!(log.contains("xcrun simctl create"), "{log}");
        assert!(log.contains("xcrun simctl bootstatus FAKE-UDID -b"), "{log}");
    }

    #[tokio::test]
    async fn a_silent_capture_process_is_reconnected() {
        let (data,tools)=fake("silent-capture");
        let frame=Mutex::new(None);
        tokio::time::timeout(Duration::from_secs(6),stream_once(&tools.axe,"U",&frame,&AtomicU64::new(0))).await.expect("a stalled stream must be killed, not held forever");
        std::fs::remove_dir_all(data.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn an_inner_screen_tap_uses_frame_geometry_instead_of_saved_outer_points() {
        let (data,tools)=fake("display-touch");
        let phone=Phone::with_tools(data,tokio::runtime::Handle::current(),tools.clone());
        phone.bot(ann(),BotRequest::Start).await.unwrap();
        let helper=tools.axe.parent().unwrap().join("touch");
        std::fs::write(&helper,"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/touch-args\"\n").unwrap();
        std::fs::set_permissions(&helper,std::fs::Permissions::from_mode(0o755)).unwrap();
        phone.state().touch=Some((helper,"developer".into()));
        { let mut frame=locked(&phone.frame); let frame=frame.as_mut().unwrap(); frame.width=1000; frame.height=600; frame.screen=Some(screens::Screen { id:3,orientation:3, ..Default::default() }); }
        phone.act(&Input::Tap {x:400,y:480}).await.unwrap();
        let args=std::fs::read_to_string(tools.axe.parent().unwrap().join("touch-args")).unwrap();
        let args: Vec<_>=args.lines().collect();
        assert_eq!(&args[..3], &["developer","FAKE-UDID","3"]);
        assert_eq!(args[3].parse::<f64>().unwrap(),0.8);
        assert_eq!(args[4].parse::<f64>().unwrap(),0.6);
        phone.act(&Input::Key {key: Key::Backspace}).await.unwrap();
        let args=std::fs::read_to_string(tools.axe.parent().unwrap().join("touch-args")).unwrap();
        assert_eq!(args.lines().collect::<Vec<_>>(),vec!["developer","FAKE-UDID","key","42"]);
        phone.act(&Input::Type {text:"OPEN".into()}).await.unwrap();
        let args=std::fs::read_to_string(tools.axe.parent().unwrap().join("touch-args")).unwrap();
        assert_eq!(args.lines().collect::<Vec<_>>(),vec!["developer","FAKE-UDID","type"]);
        phone.stop().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_start_waits_for_the_first_picture_before_reporting_ready() {
        let (data, tools) = fake("start-picture");
        let script = std::fs::read_to_string(&tools.axe).unwrap().replace(
            "stream-video) cat",
            "stream-video) while [ ! -f \"$dir/release-frame\" ]; do sleep 0.02; done; cat",
        );
        std::fs::write(&tools.axe, script).unwrap();
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        let starting = {
            let phone = Arc::clone(&phone);
            tokio::spawn(async move { phone.bot(ann(), BotRequest::Start).await })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while !phone.status().on { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        tokio::time::sleep(START_EVERY * 2).await;
        assert!(!starting.is_finished(), "start returned before the screen picture arrived");
        std::fs::write(tools.axe.parent().unwrap().join("release-frame"), "").unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), starting).await.unwrap().unwrap().unwrap();
        assert!(reply.text.contains("603×1311 pixels"), "{}", reply.text);
        assert!(phone.bot(ann(), BotRequest::Look).await.unwrap().image.is_some());
        phone.stop().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn queued_bot_actions_are_refused_after_human_takeover() {
        let requests = [
            BotRequest::Act { input: Input::Tap { x: 150, y: 300 } },
            BotRequest::TapLabel { text: "Continue".into() },
            BotRequest::Launch { bundle: "test.app".into() },
            BotRequest::Open { url: "https://example.com".into() },
        ];
        for (index, request) in requests.into_iter().enumerate() {
            let (data, tools) = fake(&format!("queued-{index}"));
            let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
            on(&phone).await;
            let held = phone.actions.lock().await;
            let bot = phone.bot(ann(), request);
            tokio::pin!(bot);
            tokio::select! {
                reply = &mut bot => panic!("bot did not queue: {reply:?}"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {},
            }
            let human = phone.human(Input::Key { key: Key::Enter });
            tokio::pin!(human);
            tokio::select! {
                reply = &mut human => panic!("human did not queue: {reply:?}"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {},
            }
            assert!(matches!(phone.status().holder, HolderView::Human { .. }));
            // A slow in-flight tool can outlast the person's idle timeout.
            phone.state().lock.tick(lock::HUMAN_IDLE_MS + 100);
            drop(held);
            let (bot, human) = tokio::join!(bot, human);
            assert_eq!(bot.unwrap().code, ReplyCode::Wait, "request {index} ran after takeover");
            human.unwrap();
            let log = calls(&tools);
            assert!(!log.contains("axe tap") && !log.contains("simctl launch") && !log.contains("simctl openurl"), "{log}");
            phone.stop().await.unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stop_reserves_shutdown_before_allowing_a_restart() {
        let (data, tools) = fake("stop-barrier");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        let barrier = phone.shutting_down.lock().await;
        let stop = phone.stop();
        tokio::pin!(stop);
        tokio::select! {
            result = &mut stop => panic!("stop bypassed shutdown barrier: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {},
        }
        assert!(phone.status().on, "Off must not be published before reserving shutdown");
        drop(barrier);
        assert!(!stop.await.unwrap().on);
        assert!(phone.view(0).frame.is_none());
        phone.bot(ann(), BotRequest::Start).await.unwrap();
        assert!(phone.bot(ann(), BotRequest::Look).await.unwrap().image.is_some());
        phone.stop().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stop_finishes_cleanup_and_reports_recording_and_shutdown_failures() {
        let (data, tools) = fake("stop-recording-error");
        let xcrun = std::fs::read_to_string(&tools.xcrun).unwrap().replace(
            "  simctl\\ create*) touch \"$dir/created\"; echo FAKE-UDID ;;",
            "  simctl\\ create*) touch \"$dir/created\"; echo FAKE-UDID ;;\n  simctl\\ io*recordVideo*) echo 'Recording started' >&2; exec sleep 30 ;;\n  simctl\\ shutdown*) echo 'shutdown failed' >&2; exit 1 ;;",
        );
        std::fs::write(&tools.xcrun, xcrun).unwrap();
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        phone.human_control(Control::Recording { active: true }).await.unwrap();

        let error = phone.stop().await.unwrap_err();
        assert!(error.contains("recording could not be finalized"), "{error}");
        assert!(error.contains("shutdown failed"), "{error}");
        assert!(!phone.status().on);
        assert!(phone.view(0).frame.is_none());
        assert!(calls(&tools).contains("xcrun simctl shutdown FAKE-UDID"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_stop_is_idempotent_when_the_phone_is_already_off() {
        let (data, tools) = fake("bot-stop-off");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());

        let first = phone.bot(ann(), BotRequest::Control { control: Control::Stop }).await.unwrap();
        let second = phone.bot(ann(), BotRequest::Control { control: Control::Stop }).await.unwrap();

        assert_eq!(first.code, ReplyCode::Ok);
        assert_eq!(second.code, ReplyCode::Ok);
        assert!(!phone.status().on);
        assert!(!calls(&tools).contains("simctl shutdown"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_restart_waits_for_the_cancelled_start_to_finish() {
        let (data, tools) = fake("restart-boot");
        let script = std::fs::read_to_string(&tools.xcrun).unwrap().replace(
            "  *) : ;;",
            "  simctl\\ bootstatus*) while [ ! -f \"$dir/release-boot\" ]; do sleep 0.02; done ;;\n  *) : ;;",
        );
        std::fs::write(&tools.xcrun, script).unwrap();
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        phone.start();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !calls(&tools).contains("simctl bootstatus") { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        phone.stop().await.unwrap();
        phone.start();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(calls(&tools).matches("simctl bootstatus").count(), 1, "two starts booted concurrently");
        std::fs::write(tools.xcrun.parent().unwrap().join("release-boot"), "").unwrap();
        on(&phone).await;
        phone.stop().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_persons_tap_is_converted_to_points() {
        let (data, tools) = fake("tap");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools.clone());
        on(&phone).await;
        phone.human(Input::Tap { x: 150, y: 300 }).await.unwrap();
        assert!(calls(&tools).contains("axe tap -x 100.0 -y 200.0 --udid FAKE-UDID"), "{}", calls(&tools));
        assert_eq!(phone.status().holder, HolderView::Human { seconds_left: 10 });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn taps_outside_the_picture_are_refused() {
        let (data, tools) = fake("outside");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        assert_eq!(phone.human(Input::Tap { x: 1, y: 1 }).await.unwrap_err(), "The phone is off. Run phone start, or turn it on in the Phone tab.");
        on(&phone).await;
        assert_eq!(phone.human(Input::Tap { x: 603, y: 10 }).await.unwrap_err(), "603,10 is outside the picture (603×1311).");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_bot_is_paused_while_the_person_drives() {
        let (data, tools) = fake("paused");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Tap { x: 10, y: 10 }).await.unwrap();
        let reply = phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 20, y: 20 } }).await.unwrap();
        assert_eq!(reply.code, ReplyCode::Wait);
        assert!(reply.text.starts_with("Paused: the person is using the phone."), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_wait_returns_after_give_back_with_chat_count() {
        let (data, tools) = fake("wait");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Type { text: "hi".into() }).await.unwrap();
        phone.chat_queued("r1");
        phone.chat_queued("r1");
        let waiting = { let phone = Arc::clone(&phone); tokio::spawn(async move { phone.bot(ann(), BotRequest::Wait).await }) };
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!waiting.is_finished(), "the bot waits while the person has the phone");
        phone.give_back();
        let reply = waiting.await.unwrap().unwrap();
        assert_eq!(reply.code, ReplyCode::Ok);
        assert!(reply.text.contains("sent 2 chat messages meanwhile. End this turn now"), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bot_wait_reports_the_persons_turn() {
        let (data, tools) = fake("look-again");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        phone.human(Input::Key { key: Key::Enter }).await.unwrap();
        let _ = phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap();
        phone.give_back();
        let reply = phone.bot(ann(), BotRequest::Wait).await.unwrap();
        assert!(reply.text.contains("run phone look first"), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_bot_that_missed_the_persons_turn_must_look_again() {
        let (data, tools) = fake("missed");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Ok);
        phone.human(Input::Tap { x: 10, y: 10 }).await.unwrap();
        phone.give_back();
        // Looking doesn't count as hearing about the person's turn.
        assert_eq!(phone.bot(ann(), BotRequest::Look).await.unwrap().code, ReplyCode::Ok);
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Wait);
        let reply = phone.bot(ann(), BotRequest::Wait).await.unwrap();
        assert!(reply.text.contains("run phone look first"), "{}", reply.text);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bots_take_turns_and_done_hands_over() {
        let (data, tools) = fake("turns");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Ok);
        let blocked = phone.bot(bo(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap();
        assert_eq!(blocked.text, "Ann is using the phone. Run: \"$APEX_DECK_BIN\" phone wait");
        phone.bot(ann(), BotRequest::Done).await.unwrap();
        assert_eq!(phone.bot(bo(), BotRequest::Act { input: Input::Tap { x: 1, y: 1 } }).await.unwrap().code, ReplyCode::Ok);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn look_returns_the_picture() {
        let (data, tools) = fake("look");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        let reply = phone.bot(ann(), BotRequest::Look).await.unwrap();
        assert!(reply.text.starts_with("Screen picture: 603×1311 pixels."), "{}", reply.text);
        use base64::Engine;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(reply.image.unwrap()).unwrap(), coords::tiny_jpeg(603, 1311));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn typing_refuses_fancy_characters() {
        let (data, tools) = fake("type");
        let phone = Phone::with_tools(data, tokio::runtime::Handle::current(), tools);
        on(&phone).await;
        assert!(phone.human(Input::Type { text: "héllo".into() }).await.unwrap_err().starts_with("Only plain keyboard characters"));
    }

    /// Run by hand on a Mac with Xcode: `cargo test -p apex-host --lib phone::tests::real -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_simulator_round_trip() {
        let data = std::env::temp_dir().join(format!("apex-phone-real-{}", std::process::id()));
        let phone = Phone::new(data.clone(), tokio::runtime::Handle::current());
        phone.start();
        for _ in 0..600 { if phone.status().on && phone.view(0).frame.is_some() { break; } tokio::time::sleep(Duration::from_millis(500)).await; }
        assert!(phone.status().on, "{:?}", phone.status().problem);
        phone.human(Input::Button { button: HwButton::Home }).await.unwrap();
        assert_eq!(phone.bot(ann(), BotRequest::Act { input: Input::Tap { x: 300, y: 600 } }).await.unwrap().code, ReplyCode::Wait);
        phone.give_back();
        assert_eq!(phone.bot(ann(), BotRequest::Wait).await.unwrap().code, ReplyCode::Ok);
        let udid = phone.status().udid.unwrap();
        phone.stop().await.unwrap();
        let _ = std::process::Command::new("xcrun").args(["simctl", "delete", &udid]).status();
        let _ = std::fs::remove_dir_all(data);
    }
}
