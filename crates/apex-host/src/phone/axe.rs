//! AXe argument lists and bounded subprocess execution for the shared phone.
use super::types::{HwButton, Key};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

pub const INPUT_LIMIT: Duration = Duration::from_secs(20);
pub const DESCRIBE_LIMIT: Duration = Duration::from_secs(60);
pub const INSTALL_LIMIT: Duration = Duration::from_secs(300);
pub const BOOT_LIMIT: Duration = Duration::from_secs(240);
pub const SIMCTL_LIMIT: Duration = Duration::from_secs(30);

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|s| (*s).into()).collect()
}
pub fn tap_args(udid: &str, x: f64, y: f64) -> Vec<String> {
    args(&[
        "tap",
        "-x",
        &format!("{x:.1}"),
        "-y",
        &format!("{y:.1}"),
        "--udid",
        udid,
    ])
}
pub fn tap_label_args(udid: &str, label: &str) -> Vec<String> {
    args(&[
        "tap",
        "--label",
        label,
        "--wait-timeout",
        "2",
        "--udid",
        udid,
    ])
}
pub fn swipe_args(udid: &str, from: (f64, f64), to: (f64, f64), ms: u32) -> Vec<String> {
    args(&[
        "swipe",
        "--start-x",
        &format!("{:.1}", from.0),
        "--start-y",
        &format!("{:.1}", from.1),
        "--end-x",
        &format!("{:.1}", to.0),
        "--end-y",
        &format!("{:.1}", to.1),
        "--duration",
        &format!("{:.2}", ms.clamp(100, 1000) as f64 / 1000.0),
        "--udid",
        udid,
    ])
}
pub fn type_args(udid: &str) -> Vec<String> {
    args(&["type", "--stdin", "--udid", udid])
}
pub fn key_args(udid: &str, key: Key) -> Vec<String> {
    args(&["key", &key.hid().to_string(), "--udid", udid])
}
pub fn button_args(udid: &str, button: HwButton) -> Vec<String> {
    args(&[
        "button",
        match button {
            HwButton::Home => "home",
            HwButton::Lock => "lock",
        },
        "--udid",
        udid,
    ])
}
pub fn describe_args(udid: &str, point: Option<(f64, f64)>) -> Vec<String> {
    let mut out = args(&["describe-ui", "--udid", udid]);
    if let Some((x, y)) = point {
        out.extend(args(&["--point", &format!("{x:.1},{y:.1}")]));
    }
    out
}
pub fn stream_args(udid: &str) -> Vec<String> {
    args(&[
        "stream-video",
        "--format",
        "raw",
        "--fps",
        "8",
        "--quality",
        "60",
        "--scale",
        "0.5",
        "--udid",
        udid,
    ])
}
pub fn check_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > 500 || !text.chars().all(|c| (' '..='~').contains(&c)) {
        Err("Only plain keyboard characters (letters, digits, punctuation and spaces) can be typed, up to 500 at a time. Use key enter for a new line.".into())
    } else {
        Ok(())
    }
}

pub async fn run_tool(
    program: &Path,
    args: &[String],
    stdin: Option<&str>,
    limit: Duration,
) -> Result<String, String> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("The phone didn't respond: {e}"))?;
    // Bound both input writing and output collection so a child that never reads
    // its input cannot hold the phone beyond the command deadline.
    let operation = async move {
        let writer = child.stdin.take();
        let write = async move {
            if let (Some(mut pipe), Some(text)) = (writer, stdin) {
                pipe.write_all(text.as_bytes()).await?;
            }
            Ok::<(), std::io::Error>(())
        };
        let (_, output) = tokio::try_join!(write, child.wait_with_output())?;
        Ok::<_, std::io::Error>(output)
    };
    let output = tokio::time::timeout(limit, operation)
        .await
        .map_err(|_| "The phone took too long to respond.".to_string())?
        .map_err(|e| format!("The phone didn't respond: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr
            .lines()
            .rev()
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("it gave no reason");
        return Err(format!("The phone didn't respond: {reason}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::types::{BotRequest, HwButton, Input, Key};

    fn s(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn argument_lists_match_axe_1_8() {
        assert_eq!(
            tap_args("U", 100.0, 200.5),
            s(&["tap", "-x", "100.0", "-y", "200.5", "--udid", "U"])
        );
        assert_eq!(
            tap_label_args("U", "Send"),
            s(&[
                "tap",
                "--label",
                "Send",
                "--wait-timeout",
                "2",
                "--udid",
                "U"
            ])
        );
        assert_eq!(
            swipe_args("U", (10.0, 600.0), (10.0, 200.0), 50),
            s(&[
                "swipe",
                "--start-x",
                "10.0",
                "--start-y",
                "600.0",
                "--end-x",
                "10.0",
                "--end-y",
                "200.0",
                "--duration",
                "0.10",
                "--udid",
                "U"
            ])
        );
        assert_eq!(swipe_args("U", (0.0, 0.0), (1.0, 1.0), 5_000)[10], "1.00");
        assert_eq!(type_args("U"), s(&["type", "--stdin", "--udid", "U"]));
        assert_eq!(key_args("U", Key::Enter), s(&["key", "40", "--udid", "U"]));
        assert_eq!(key_args("U", Key::Up), s(&["key", "82", "--udid", "U"]));
        assert_eq!(
            button_args("U", HwButton::Home),
            s(&["button", "home", "--udid", "U"])
        );
        assert_eq!(describe_args("U", None), s(&["describe-ui", "--udid", "U"]));
        assert_eq!(
            describe_args("U", Some((66.0, 197.3))),
            s(&["describe-ui", "--udid", "U", "--point", "66.0,197.3"])
        );
        assert_eq!(
            stream_args("U"),
            s(&[
                "stream-video",
                "--format",
                "raw",
                "--fps",
                "8",
                "--quality",
                "60",
                "--scale",
                "0.5",
                "--udid",
                "U"
            ])
        );
    }

    #[test]
    fn only_plain_keyboard_text_can_be_typed() {
        assert_eq!(check_text("Hello, world! 42"), Ok(()));
        for bad in ["", "héllo", "line\nbreak", "🙂"] {
            assert!(check_text(bad).is_err(), "{bad:?}");
        }
        assert!(check_text(&"a".repeat(500)).is_ok());
        assert!(check_text(&"a".repeat(501)).is_err());
    }

    #[test]
    fn requests_have_the_wire_shape() {
        let tap: BotRequest = serde_json::from_value(
            serde_json::json!({"kind": "act", "input": {"kind": "tap", "x": 1, "y": 2}}),
        )
        .unwrap();
        assert_eq!(
            tap,
            BotRequest::Act {
                input: Input::Tap { x: 1, y: 2 }
            }
        );
        let swipe: Input = serde_json::from_value(
            serde_json::json!({"kind": "swipe", "x1": 1, "y1": 2, "x2": 3, "y2": 4}),
        )
        .unwrap();
        assert_eq!(
            swipe,
            Input::Swipe {
                x1: 1,
                y1: 2,
                x2: 3,
                y2: 4,
                ms: 300
            }
        );
        let label: BotRequest =
            serde_json::from_value(serde_json::json!({"kind": "tapLabel", "text": "Send"}))
                .unwrap();
        assert_eq!(
            label,
            BotRequest::TapLabel {
                text: "Send".into()
            }
        );
        let wait: BotRequest = serde_json::from_value(serde_json::json!({"kind": "wait"})).unwrap();
        assert_eq!(wait, BotRequest::Wait);
    }

    #[tokio::test]
    async fn run_tool_returns_output_or_the_last_error_line() {
        let sh = std::path::Path::new("/bin/sh");
        assert_eq!(
            run_tool(sh, &s(&["-c", "cat"]), Some("hi"), INPUT_LIMIT).await,
            Ok("hi".into())
        );
        let err = run_tool(
            sh,
            &s(&["-c", "echo one >&2; echo two >&2; exit 3"]),
            None,
            INPUT_LIMIT,
        )
        .await
        .unwrap_err();
        assert_eq!(err, "The phone didn't respond: two");
        let slow = run_tool(
            sh,
            &s(&["-c", "sleep 5"]),
            None,
            std::time::Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert_eq!(slow, "The phone took too long to respond.");
    }
}
