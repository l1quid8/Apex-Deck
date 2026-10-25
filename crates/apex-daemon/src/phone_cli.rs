//! `apex-daemon phone <verb>`: how Claude and Codex bots use the shared phone.
//!
//! The bot runs this inside its turn. It reads the turn's identity from the
//! environment, asks the running daemon (over its local socket) to do one
//! thing with the phone, and prints the answer.

use std::io::Read;
use std::path::{Path, PathBuf};

use apex_host::phone::guide::GUIDE;
use apex_host::phone::{BotReply, BotRequest, Control, HwButton, Input, Key, ReplyCode};
use base64::Engine;
use serde_json::json;

use crate::local_call::through_daemon;

const UNKNOWN: &str = "Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help";
const NOT_IN_A_TURN: &str = "This command only works inside an Apex Deck bot turn.";
const NOT_REACHABLE: &str = "Deck isn't reachable. Is the Apex Deck app running?";
/// `phone wait` that has to give up: the bot should ask again.
const WAIT_EXIT: i32 = 75;
const DEFAULT_SWIPE_MS: u32 = 300;

#[derive(Debug)]
pub(crate) enum Parsed {
    Help,
    Request(BotRequest),
}

/// Runs `phone <args>` and returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let request = match parse(args, read_stdin) {
        Ok(Parsed::Help) => {
            println!("{GUIDE}");
            return 0;
        }
        Ok(Parsed::Request(request)) => request,
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    };
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let (Some(socket), Some(room), Some(bot), Some(name)) = (env("APEX_DECK_PHONE_SOCKET"), env("APEX_DECK_ROOM"), env("APEX_DECK_BOT"), env("APEX_DECK_BOT_NAME")) else {
        eprintln!("{NOT_IN_A_TURN}");
        return 1;
    };
    // The daemon's folder isn't the bot's, so a relative path means nothing there.
    let request = match request {
        BotRequest::Install { .. } => match std::env::current_dir() {
            Ok(folder) => in_folder(request, &folder),
            Err(why) => {
                eprintln!("Could not find the folder this command runs in: {why}");
                return 1;
            }
        },
        other => other,
    };
    let Ok(socket) = std::os::unix::net::UnixStream::connect(&socket) else {
        eprintln!("{NOT_REACHABLE}");
        return 1;
    };
    let call = json!({ "cmd": "phone_bot", "args": { "room": room, "bot": bot, "name": name, "request": request } });
    let reply = through_daemon(socket, call).and_then(|answer| serde_json::from_value::<BotReply>(answer).map_err(|e| e.to_string()));
    let reply = match reply {
        Ok(reply) => reply,
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    };
    println!("{}", reply.text);
    match save_look(&reply, &std::env::temp_dir().join("apex-phone")) {
        Ok(Some(path)) => println!("Picture: {}", path.display()),
        Ok(None) => {}
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    }
    exit_code(&reply)
}

fn read_stdin() -> String {
    let mut bytes = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn numbers(verb: &str) -> String {
    format!("{verb} needs whole numbers: pixels in the latest look picture.")
}

fn number(verb: &str, word: &str) -> Result<u32, String> {
    word.parse().map_err(|_| numbers(verb))
}

fn one_word<'a>(rest: &'a [String], missing: &str) -> Result<&'a str, String> {
    match rest {
        [word] => Ok(word),
        _ => Err(missing.to_string()),
    }
}

fn key_named(name: &str) -> Result<Key, String> {
    Ok(match name {
        "enter" => Key::Enter,
        "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        _ => return Err("key needs a name: enter, escape, backspace, tab, space, up, down, left or right.".into()),
    })
}

/// Reads `args` (everything after `phone`). `stdin` is only called for `type --stdin`.
pub(crate) fn parse(args: &[String], stdin: impl FnOnce() -> String) -> Result<Parsed, String> {
    let Some((verb, rest)) = args.split_first() else {
        return Err(UNKNOWN.into());
    };
    let act = |input: Input| Ok(Parsed::Request(BotRequest::Act { input }));
    let plain = |request: BotRequest| Ok(Parsed::Request(request));
    match verb.as_str() {
        "devices" if rest.is_empty() => plain(BotRequest::Devices),
        "fold" | "unfold" | "rotate" | "appearance" | "text-size" | "contrast" | "status-bar" | "screenshot" | "record" | "volume" | "biometric" | "location" | "device" | "stop" => {
            let value = || one_word(rest, "This control needs exactly one value. Run phone help.");
            let switch = |v: &str| -> Result<bool, String> { match v { "on" => Ok(true), "off" => Ok(false), _ => Err("Use on or off.".into()) } };
            let control = match verb.as_str() {
                "fold" | "unfold" if rest.is_empty() => Control::Fold { folded: verb == "fold" },
                "rotate" => Control::Rotate { orientation: match value()? { "portrait" => 1, "upside-down" => 2, "landscape-left" => 3, "landscape-right" => 4, _ => return Err("Rotate needs portrait, upside-down, landscape-left or landscape-right.".into()) } },
                "appearance" => Control::Appearance { value: value()?.into() },
                "text-size" => Control::TextSize { value: value()?.into() },
                "contrast" => Control::Contrast { enabled: switch(value()?)? },
                "status-bar" => Control::StatusBar { clean: match value()? { "clean" => true, "live" => false, _ => return Err("Use status-bar clean or live.".into()) } },
                "screenshot" if rest.is_empty() => Control::Screenshot,
                "record" => Control::Recording { active: match value()? { "start" => true, "stop" => false, _ => return Err("Use record start or stop.".into()) } },
                "volume" => Control::Volume { direction: value()?.into() },
                "biometric" => Control::Biometric { matched: match value()? { "match" => true, "fail" => false, _ => return Err("Use biometric match or fail.".into()) } },
                "location" => match rest {
                    [word] if word == "reset" => Control::Location { latitude: None, longitude: None },
                    [a, b] => Control::Location { latitude: Some(a.parse().map_err(|_| "Invalid latitude")?), longitude: Some(b.parse().map_err(|_| "Invalid longitude")?) },
                    _ => return Err("Use location LAT LON or location reset.".into()),
                },
                "device" => match rest { [runtime, device_type] => Control::SelectDevice { runtime: runtime.clone(), device_type: device_type.clone() }, _ => return Err("Use device RUNTIME_ID DEVICE_TYPE_ID from phone devices.".into()) },
                "stop" if rest.is_empty() => Control::Stop,
                _ => return Err("Unexpected control arguments. Run phone help.".into()),
            };
            apex_host::phone::controls::validate(&control)?;
            plain(BotRequest::Control { control })
        }
        "help" => Ok(Parsed::Help),
        "status" => plain(BotRequest::Status),
        "start" => plain(BotRequest::Start),
        "look" => plain(BotRequest::Look),
        "elements" => plain(BotRequest::Elements),
        "wait" => plain(BotRequest::Wait),
        "done" => plain(BotRequest::Done),
        "tap" => match rest {
            [flag, words @ ..] if flag == "--label" => {
                if words.is_empty() {
                    return Err("tap --label needs the text on the button.".into());
                }
                plain(BotRequest::TapLabel { text: words.join(" ") })
            }
            [x, y] => act(Input::Tap { x: number(verb, x)?, y: number(verb, y)? }),
            _ => Err(numbers(verb)),
        },
        "swipe" => {
            let (spots, ms) = match rest {
                [_, _, _, _] => (rest, DEFAULT_SWIPE_MS),
                [_, _, _, _, flag, ms] if flag == "--ms" => (&rest[..4], number(verb, ms)?),
                _ => return Err(numbers(verb)),
            };
            let [x1, y1, x2, y2] = [0, 1, 2, 3].map(|i| number(verb, &spots[i]));
            act(Input::Swipe { x1: x1?, y1: y1?, x2: x2?, y2: y2?, ms })
        }
        "type" => {
            if rest.first().is_some_and(|flag| flag == "--stdin") {
                if rest.len() > 1 {
                    return Err("type --stdin takes no other words.".into());
                }
                let mut text = stdin();
                // `echo text | phone type --stdin` ends in a newline nobody meant to type.
                if text.ends_with('\n') {
                    text.pop();
                    if text.ends_with('\r') {
                        text.pop();
                    }
                }
                if text.is_empty() {
                    return Err("type --stdin got no text.".into());
                }
                return act(Input::Type { text });
            }
            if rest.is_empty() {
                return Err("type needs some text.".into());
            }
            act(Input::Type { text: rest.join(" ") })
        }
        "key" => act(Input::Key { key: key_named(one_word(rest, "key needs a name: enter, escape, backspace, tab, space, up, down, left or right.")?)? }),
        "button" => {
            let button = match one_word(rest, "button needs home or lock.")? {
                "home" => HwButton::Home,
                "lock" => HwButton::Lock,
                _ => return Err("button needs home or lock.".into()),
            };
            act(Input::Button { button })
        }
        "what" => match rest {
            [x, y] => plain(BotRequest::What { x: number(verb, x)?, y: number(verb, y)? }),
            _ => Err(numbers(verb)),
        },
        "install" => plain(BotRequest::Install { path: one_word(rest, "install needs one path. Put it in quotes if it has spaces.")?.into() }),
        "launch" => plain(BotRequest::Launch { bundle: one_word(rest, "launch needs one bundle id.")?.into() }),
        "open" => plain(BotRequest::Open { url: one_word(rest, "open needs one link.")?.into() }),
        _ => Err(UNKNOWN.into()),
    }
}

/// A relative `install` path means the bot's folder, not the daemon's.
pub(crate) fn in_folder(request: BotRequest, folder: &Path) -> BotRequest {
    match request {
        BotRequest::Install { path } => BotRequest::Install { path: folder.join(path).to_string_lossy().into_owned() },
        other => other,
    }
}

/// 0 when the command worked; 75 when the phone was busy and the bot should run `phone wait`.
pub(crate) fn exit_code(reply: &BotReply) -> i32 {
    match reply.code {
        ReplyCode::Ok => 0,
        ReplyCode::Wait => WAIT_EXIT,
    }
}

/// Saves the screen picture, if the reply has one, and says where it went.
pub(crate) fn save_look(reply: &BotReply, dir: &Path) -> Result<Option<PathBuf>, String> {
    let Some(image) = &reply.image else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(image).map_err(|_| "The screen picture could not be read.".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the screen picture: {e}"))?;
    let name = reply.seq.map_or_else(|| "look.jpg".to_string(), |seq| format!("look-{seq}.jpg"));
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save the screen picture: {e}"))?;
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_host::phone::{BotReply, BotRequest, HwButton, Input, Key, ReplyCode};

    fn p(line: &str) -> Result<Parsed, String> {
        parse(&line.split_whitespace().map(str::to_string).collect::<Vec<_>>(), || "from stdin".into())
    }
    fn req(line: &str) -> BotRequest {
        match p(line).unwrap() { Parsed::Request(r) => r, Parsed::Help => panic!("help") }
    }

    #[test]
    fn simulator_controls_share_the_host_contract() {
        assert_eq!(req("fold"), BotRequest::Control { control: apex_host::phone::Control::Fold { folded: true } });
        assert_eq!(req("rotate landscape-left"), BotRequest::Control { control: apex_host::phone::Control::Rotate { orientation: 3 } });
        assert!(p("location 91 0").is_err());
        assert!(p("appearance purple").is_err());
        assert!(p("fold surprise").is_err());
        assert_eq!(req("devices"), BotRequest::Devices);
    }

    #[test]
    fn verbs_become_requests() {
        assert!(matches!(p("help").unwrap(), Parsed::Help));
        assert_eq!(req("tap 10 20"), BotRequest::Act { input: Input::Tap { x: 10, y: 20 } });
        assert_eq!(req("tap --label Sign in"), BotRequest::TapLabel { text: "Sign in".into() });
        assert_eq!(req("swipe 1 2 3 4"), BotRequest::Act { input: Input::Swipe { x1: 1, y1: 2, x2: 3, y2: 4, ms: 300 } });
        assert_eq!(req("swipe 1 2 3 4 --ms 600"), BotRequest::Act { input: Input::Swipe { x1: 1, y1: 2, x2: 3, y2: 4, ms: 600 } });
        assert_eq!(req("type hello world"), BotRequest::Act { input: Input::Type { text: "hello world".into() } });
        assert_eq!(req("type --stdin"), BotRequest::Act { input: Input::Type { text: "from stdin".into() } });
        assert_eq!(req("key enter"), BotRequest::Act { input: Input::Key { key: Key::Enter } });
        assert_eq!(req("button lock"), BotRequest::Act { input: Input::Button { button: HwButton::Lock } });
        assert_eq!(req("what 5 6"), BotRequest::What { x: 5, y: 6 });
        assert_eq!(req("launch com.example.app"), BotRequest::Launch { bundle: "com.example.app".into() });
        for (line, want) in [("status", BotRequest::Status), ("start", BotRequest::Start), ("look", BotRequest::Look), ("elements", BotRequest::Elements), ("wait", BotRequest::Wait), ("done", BotRequest::Done)] {
            assert_eq!(req(line), want, "{line}");
        }
    }

    #[test]
    fn mistakes_explain_themselves() {
        assert_eq!(p("tap ten 20").unwrap_err(), "tap needs whole numbers: pixels in the latest look picture.");
        assert_eq!(p("fly").unwrap_err(), "Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help");
        assert_eq!(p("").unwrap_err(), "Unknown phone command. Run: \"$APEX_DECK_BIN\" phone help");
        assert!(p("key shift").is_err());
    }

    #[test]
    fn exit_codes_and_pictures() {
        assert_eq!(exit_code(&BotReply::ok("x")), 0);
        assert_eq!(exit_code(&BotReply::wait("x")), 75);
        let dir = std::env::temp_dir().join(format!("apex-phone-look-{}", std::process::id()));
        let reply = BotReply { code: ReplyCode::Ok, text: "Screen picture".into(), image: Some("/9j/".into()), seq: Some(7) };
        let saved = save_look(&reply, &dir).unwrap().unwrap();
        assert_eq!(saved, dir.join("look-7.jpg"));
        assert_eq!(std::fs::read(&saved).unwrap(), vec![0xFF, 0xD8, 0xFF]);
        assert_eq!(save_look(&BotReply::ok("no picture"), &dir).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stdin_text_loses_one_trailing_newline() {
        let typed = |from_stdin: &str| {
            let from_stdin = from_stdin.to_string();
            match parse(&["type".to_string(), "--stdin".to_string()], move || from_stdin).unwrap() {
                Parsed::Request(BotRequest::Act { input: Input::Type { text } }) => text,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(typed("text\n"), "text");
        assert_eq!(typed("text\r\n"), "text");
        assert_eq!(typed("text"), "text");
        assert_eq!(typed("a\n\n"), "a\n");
        let nothing = parse(&["type".to_string(), "--stdin".to_string()], || "\n".into());
        assert_eq!(nothing.err().unwrap(), "type --stdin got no text.");
    }

    #[test]
    fn small_mistakes_get_plain_answers() {
        assert_eq!(p("swipe 1 2 3").unwrap_err(), "swipe needs whole numbers: pixels in the latest look picture.");
        assert_eq!(p("swipe 1 2 3 4 --ms slow").unwrap_err(), "swipe needs whole numbers: pixels in the latest look picture.");
        assert_eq!(p("what 5").unwrap_err(), "what needs whole numbers: pixels in the latest look picture.");
        assert_eq!(p("tap --label").unwrap_err(), "tap --label needs the text on the button.");
        assert_eq!(p("type").unwrap_err(), "type needs some text.");
        assert_eq!(p("key").unwrap_err(), "key needs a name: enter, escape, backspace, tab, space, up, down, left or right.");
        assert_eq!(p("button power").unwrap_err(), "button needs home or lock.");
        assert_eq!(p("launch").unwrap_err(), "launch needs one bundle id.");
        assert_eq!(p("open").unwrap_err(), "open needs one link.");
        assert_eq!(p("install a b").unwrap_err(), "install needs one path. Put it in quotes if it has spaces.");
        assert_eq!(req("install build/App.app"), BotRequest::Install { path: "build/App.app".into() });
        assert_eq!(req("open https://example.com"), BotRequest::Open { url: "https://example.com".into() });
    }

    #[test]
    fn a_relative_install_path_is_made_absolute_against_the_bots_folder() {
        let here = Path::new("/work/proj");
        let install = |path: &str| BotRequest::Install { path: path.into() };
        assert_eq!(in_folder(install("build/App.app"), here), install("/work/proj/build/App.app"));
        assert_eq!(in_folder(install("/abs/App.app"), here), install("/abs/App.app"));
        assert_eq!(in_folder(BotRequest::Look, here), BotRequest::Look);
    }
}
