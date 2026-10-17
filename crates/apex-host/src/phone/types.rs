//! Requests, replies and screen state for the shared phone.
use super::lock::HolderView;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Key {
    Enter,
    Backspace,
    Tab,
    Escape,
    Space,
    Up,
    Down,
    Left,
    Right,
}
impl Key {
    pub fn hid(self) -> u8 {
        match self {
            Self::Enter => 40,
            Self::Escape => 41,
            Self::Backspace => 42,
            Self::Tab => 43,
            Self::Space => 44,
            Self::Right => 79,
            Self::Left => 80,
            Self::Down => 81,
            Self::Up => 82,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HwButton {
    Home,
    Lock,
}

fn default_swipe_ms() -> u32 {
    300
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Input {
    Tap {
        x: u32,
        y: u32,
    },
    Swipe {
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        #[serde(default = "default_swipe_ms")]
        ms: u32,
    },
    Type {
        text: String,
    },
    Key {
        key: Key,
    },
    Button {
        button: HwButton,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BotRequest {
    Status,
    Start,
    Look,
    Act { input: Input },
    TapLabel { text: String },
    What { x: u32, y: u32 },
    Elements,
    Install { path: String },
    Launch { bundle: String },
    Open { url: String },
    Wait,
    Done,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplyCode {
    Ok,
    Wait,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotReply {
    pub code: ReplyCode,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}
impl BotReply {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            code: ReplyCode::Ok,
            text: text.into(),
            image: None,
            seq: None,
        }
    }
    pub fn wait(text: impl Into<String>) -> Self {
        Self {
            code: ReplyCode::Wait,
            text: text.into(),
            image: None,
            seq: None,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub on: bool,
    pub starting: bool,
    pub device: Option<String>,
    pub udid: Option<String>,
    pub holder: HolderView,
    pub width: u32,
    pub height: u32,
    pub problem: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameView {
    pub seq: u64,
    pub image: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub status: Status,
    pub frame: Option<FrameView>,
}
