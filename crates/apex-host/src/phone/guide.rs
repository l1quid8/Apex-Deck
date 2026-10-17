//! What bots read: the phone guide, and the plain messages that tell a bot what to do next.
use super::lock::{Busy, HolderView, WaitOutcome};
use super::types::Status;

pub const GUIDE: &str = r#"Deck phone: one simulated iPhone shared by everyone in this Deck. The person watches it in the Phone tab and can tap and type on it too.

Run every command as: "$APEX_DECK_BIN" phone <command>

Looking
  status                 On or off, who has it, its UDID and picture size.
  start                  Turn it on. The first time takes about a minute.
  look                   Save a picture of the screen and print its path. Open the picture to see it.
  what X Y               Name the thing at a spot. Works inside web pages too.
  elements               List named buttons and fields. Native screens only, and slow (about 10 seconds). Web page content is not listed.

Doing (X Y are pixels in the latest look picture, counted from its top-left corner)
  tap X Y                Tap a spot.
  tap --label "Text"     Tap a native button or field by its name. Not inside web pages.
  swipe X1 Y1 X2 Y2      Swipe. Add --ms 600 for a slower swipe.
  type "text"            Type into the focused field. Plain keyboard characters only.
  key enter|backspace|tab|escape|space|up|down|left|right
  button home|lock
  install PATH.app       Install a built app.
  launch BUNDLE_ID       Start an app. Restarts it if it's running.
  open URL               Open a link: a web page or a deep link.

Taking turns
  One driver at a time, and the person always wins.
  If a command says the phone is busy, say so in one short line, then run: phone wait
  phone wait returns when the phone is yours, after at most 100 seconds. Give it a long timeout. Do what it says.
  Run phone done when you finish testing, so the other bot can use the phone.

Building
  Get the UDID from phone status, then build for it:
    xcodebuild -scheme <Scheme> -destination "id=<UDID>" -derivedDataPath build/DerivedData build
  Install build/DerivedData/Build/Products/Debug-iphonesimulator/<App>.app, then launch its bundle id.
  For a web-based app (Capacitor), sync its web files first. For Apex Deck's own phone app: npm run iphone:sync
  Testing Apex Deck's own phone app: pair it only with a throwaway daemon, never the person's real one.
  New apps: write a project.yml and run xcodegen generate. XcodeGen must be installed (brew install xcodegen).
  Never use the person's own simulators or real iPhone unless they ask.

Checking your work
  After each change: build, install, launch, look. Say what you see before calling it done.
  Inside web pages, elements can't see buttons: use look, then what X Y to check a spot before tapping it."#;

pub fn busy_text(busy: &Busy) -> String {
    match busy {
        Busy::Human => "Paused: the person is using the phone. Say so in one short line in the chat, then run: \"$APEX_DECK_BIN\" phone wait".into(),
        Busy::Bot { name } => format!("{name} is using the phone. Run: \"$APEX_DECK_BIN\" phone wait"),
    }
}

pub fn wait_text(outcome: Option<&WaitOutcome>) -> String {
    let Some(outcome) = outcome else {
        return "The phone is still in use. Run phone wait again.".into();
    };
    let Some(seconds) = outcome.human_seconds else {
        return "The phone is yours. Go ahead.".into();
    };
    let used = match seconds {
        1 => "The person used the phone for 1 second".to_string(),
        n => format!("The person used the phone for {n} seconds"),
    };
    let (sent, theirs) = match outcome.queued {
        0 => return format!("{used} and handed it back. The screen may have changed: run phone look first, then say in one short line that you're picking back up."),
        1 => ("1 chat message".to_string(), "Their message comes"),
        n => (format!("{n} chat messages"), "Their messages come"),
    };
    format!("{used} and sent {sent} meanwhile. End this turn now with one short line saying where you stopped. {theirs} next, and you'll pick up from there.")
}

/// Who has the phone, as one sentence.
pub(crate) fn holder_text(holder: &HolderView) -> String {
    match holder {
        HolderView::Free => "Nobody is using it.".to_string(),
        HolderView::Human { .. } => "The person is using it.".to_string(),
        HolderView::Bot { name } => format!("{name} is using it."),
    }
}

pub fn status_text(status: &Status) -> String {
    if status.on {
        let holder = holder_text(&status.holder);
        format!(
            "The phone is on: {}, UDID {}. Pictures are {}×{} pixels. {holder}",
            status.device.as_deref().unwrap_or("unnamed"),
            status.udid.as_deref().unwrap_or("unknown"),
            status.width,
            status.height,
        )
    } else if status.starting {
        "The phone is turning on. Run phone status again in a few seconds.".into()
    } else {
        let mut text = String::from("The phone is off. Run phone start to turn it on.");
        if let Some(problem) = &status.problem {
            text.push_str(&format!(" Last problem: {problem}"));
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::lock::{Busy, HolderView, WaitOutcome};
    use crate::phone::types::Status;

    #[test]
    fn busy_messages_tell_the_bot_what_to_do() {
        assert_eq!(
            busy_text(&Busy::Human),
            "Paused: the person is using the phone. Say so in one short line in the chat, then run: \"$APEX_DECK_BIN\" phone wait"
        );
        assert_eq!(
            busy_text(&Busy::Bot { name: "Ann".into() }),
            "Ann is using the phone. Run: \"$APEX_DECK_BIN\" phone wait"
        );
    }

    #[test]
    fn wait_messages_cover_every_ending() {
        assert_eq!(
            wait_text(None),
            "The phone is still in use. Run phone wait again."
        );
        assert_eq!(
            wait_text(Some(&WaitOutcome {
                human_seconds: None,
                queued: 0
            })),
            "The phone is yours. Go ahead."
        );
        assert_eq!(
            wait_text(Some(&WaitOutcome { human_seconds: Some(42), queued: 0 })),
            "The person used the phone for 42 seconds and handed it back. The screen may have changed: run phone look first, then say in one short line that you're picking back up."
        );
        assert_eq!(
            wait_text(Some(&WaitOutcome { human_seconds: Some(1), queued: 1 })),
            "The person used the phone for 1 second and sent 1 chat message meanwhile. End this turn now with one short line saying where you stopped. Their message comes next, and you'll pick up from there."
        );
        assert_eq!(
            wait_text(Some(&WaitOutcome { human_seconds: Some(9), queued: 2 })),
            "The person used the phone for 9 seconds and sent 2 chat messages meanwhile. End this turn now with one short line saying where you stopped. Their messages come next, and you'll pick up from there."
        );
    }

    #[test]
    fn status_reads_plainly() {
        let mut status = Status {
            on: false,
            starting: false,
            device: None,
            udid: None,
            holder: HolderView::Free,
            width: 0,
            height: 0,
            problem: None,
        };
        assert_eq!(
            status_text(&status),
            "The phone is off. Run phone start to turn it on."
        );
        status.problem = Some("Xcode isn't installed.".into());
        assert_eq!(
            status_text(&status),
            "The phone is off. Run phone start to turn it on. Last problem: Xcode isn't installed."
        );
        status = Status {
            on: false,
            starting: true,
            ..status
        };
        assert_eq!(
            status_text(&status),
            "The phone is turning on. Run phone status again in a few seconds."
        );
        let on = Status {
            on: true,
            starting: false,
            device: Some("Apex Deck Phone 1a2b".into()),
            udid: Some("U".into()),
            holder: HolderView::Bot { name: "Ann".into() },
            width: 603,
            height: 1311,
            problem: None,
        };
        assert_eq!(
            status_text(&on),
            "The phone is on: Apex Deck Phone 1a2b, UDID U. Pictures are 603×1311 pixels. Ann is using it."
        );
    }

    #[test]
    fn the_guide_names_every_command() {
        for word in [
            "status",
            "start",
            "look",
            "what X Y",
            "elements",
            "tap X Y",
            "tap --label",
            "swipe",
            "type",
            "key",
            "button",
            "install",
            "launch",
            "open",
            "wait",
            "done",
            "xcodebuild",
        ] {
            assert!(GUIDE.contains(word), "{word}");
        }
    }
}
