//! AXe argument lists and bounded subprocess execution for the shared phone.
use super::types::{HwButton, Key};
use serde_json::Value;
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

const MAX_LINES: usize = 200;

fn unreadable() -> String {
    "The phone's screen reader gave something unreadable.".into()
}

/// `{type} "{label}"` plus ` value "{value}"`, when the element has a label or value.
fn name_of(el: &Value) -> Option<String> {
    let label = el["AXLabel"].as_str().unwrap_or("");
    let value = el["AXValue"].as_str().unwrap_or("");
    if label.is_empty() && value.is_empty() {
        return None;
    }
    let kind = el["type"].as_str().unwrap_or("Element");
    let mut out = format!("{kind} \"{label}\"");
    if !value.is_empty() {
        out.push_str(&format!(" value \"{value}\""));
    }
    Some(out)
}

/// ` at {cx},{cy} size {w}x{h}` in picture pixels, when the element has a usable frame.
fn place_of(el: &Value, scale: f64) -> Option<String> {
    let frame = el.get("frame")?;
    let n = |key: &str| frame.get(key)?.as_f64();
    let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let px = |v: f64| (v * scale).round() as u32;
    Some(format!(
        " at {},{} size {}x{}",
        px(x + w / 2.0),
        px(y + h / 2.0),
        px(w),
        px(h)
    ))
}

fn collect(el: &Value, scale: f64, out: &mut Vec<String>) {
    for child in el["children"].as_array().into_iter().flatten() {
        if out.len() >= MAX_LINES {
            return;
        }
        if let (Some(name), Some(place)) = (name_of(child), place_of(child, scale)) {
            out.push(format!("{name}{place}"));
        }
        collect(child, scale, out);
    }
}

/// Named things on a native screen, one line each. `scale` is picture pixels per point.
pub fn element_lines(json: &str, scale: f64) -> Result<Vec<String>, String> {
    let tree: Value = serde_json::from_str(json).map_err(|_| unreadable())?;
    let roots = match &tree {
        Value::Array(roots) => roots.iter().collect(),
        Value::Object(_) => vec![&tree],
        _ => return Err(unreadable()),
    };
    let mut lines = Vec::new();
    for root in roots {
        collect(root, scale, &mut lines);
    }
    Ok(lines)
}

/// The one thing at a spot, from `describe-ui --point`.
pub fn point_line(json: &str, scale: f64) -> Result<String, String> {
    let tree: Value = serde_json::from_str(json).map_err(|_| unreadable())?;
    let el = match &tree {
        Value::Array(items) => items.first(),
        Value::Object(_) => Some(&tree),
        _ => return Err(unreadable()),
    };
    Ok(el
        .and_then(|el| {
            Some(format!(
                "{}{}",
                name_of(el)?,
                place_of(el, scale).unwrap_or_default()
            ))
        })
        .unwrap_or_else(|| "Nothing named there.".into()))
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

    const TREE: &str = r#"[{"type":"Application","AXLabel":"Safari","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
        {"type":"Group","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
          {"type":"Button","AXLabel":"Back","frame":{"x":34,"y":792,"width":48,"height":48},"children":[]},
          {"type":"TextField","AXLabel":"Address","AXValue":"127.0.0.1","frame":{"x":168,"y":806,"width":66,"height":20.33},"children":[]},
          {"type":"StaticText","frame":{"x":94,"y":796,"width":0,"height":0}},
          {"type":"Button","AXLabel":"Hidden","frame":{"x":10,"y":10,"width":0,"height":0}}
        ]}]}]"#;

    #[test]
    fn element_lines_list_named_things_by_their_centre_in_picture_pixels() {
        assert_eq!(
            element_lines(TREE, 1.5).unwrap(),
            vec![
                r#"Button "Back" at 87,1224 size 72x72"#.to_string(),
                r#"TextField "Address" value "127.0.0.1" at 302,1224 size 99x30"#.to_string(),
            ]
        );
        assert!(element_lines("nonsense", 1.5).is_err());
    }

    #[test]
    fn element_lines_stop_at_200_and_never_list_the_roots() {
        let one = r#"{"type":"Button","AXLabel":"B","frame":{"x":0,"y":0,"width":2,"height":2}}"#;
        let many = vec![one; 250].join(",");
        let json = format!(
            r#"[{{"type":"Application","AXLabel":"Root","frame":{{"x":0,"y":0,"width":9,"height":9}},"children":[{many}]}}]"#
        );
        let lines = element_lines(&json, 1.0).unwrap();
        assert_eq!(lines.len(), 200);
        assert!(lines.iter().all(|l| l.starts_with("Button")));
    }

    #[test]
    fn point_line_names_one_thing_even_inside_a_web_page() {
        let send = r#"{"type":"Button","AXLabel":"Send","frame":{"x":48,"y":263,"width":102,"height":66}}"#;
        assert_eq!(
            point_line(send, 1.5).unwrap(),
            r#"Button "Send" at 149,444 size 153x99"#
        );
        assert_eq!(
            point_line(r#"{"type":"Group"}"#, 1.5).unwrap(),
            "Nothing named there."
        );
        assert_eq!(
            point_line(&format!("[{send}]"), 1.5).unwrap(),
            r#"Button "Send" at 149,444 size 153x99"#
        );
    }

    #[test]
    fn point_line_copes_with_a_missing_frame_or_type() {
        assert_eq!(
            point_line(r#"{"type":"Button","AXLabel":"Send"}"#, 1.5).unwrap(),
            r#"Button "Send""#
        );
        assert_eq!(
            point_line(
                r#"{"type":"Button","AXLabel":"Send","frame":{"x":1,"y":1,"width":0,"height":9}}"#,
                1.5
            )
            .unwrap(),
            r#"Button "Send""#
        );
        assert_eq!(
            point_line(
                r#"{"AXLabel":"Send","frame":{"x":0,"y":0,"width":2,"height":2}}"#,
                1.0
            )
            .unwrap(),
            r#"Element "Send" at 1,1 size 2x2"#
        );
        assert_eq!(point_line("[]", 1.5).unwrap(), "Nothing named there.");
        assert_eq!(
            point_line("nonsense", 1.5).unwrap_err(),
            "The phone's screen reader gave something unreadable."
        );
    }

    #[cfg(unix)]
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
