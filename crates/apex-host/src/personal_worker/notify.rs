//! When the assistant brings something to the human. Checked in code, in
//! order: is it new (fingerprint), is it urgent (needs a decision or a
//! deadline is close), quiet hours, and grouping of the rest into a digest.
//! Permission to notify is never permission to do anything else.

use crate::personal::{Notice, PersonalAssistant, MAX_NOTICES};

/// Non-urgent notices wait this long so they can go out together.
pub const DIGEST_MS: u64 = 20 * 60 * 1000;
/// The human was just here: a notice about what they're looking at is noise.
const ACTIVE_MS: u64 = 2 * 60 * 1000;

fn minutes(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// When quiet hours end, if `at` falls inside them.
pub fn quiet_until(assistant: &PersonalAssistant, at: u64) -> Option<u64> {
    let quiet = assistant.quiet_hours.as_ref()?;
    let (start, end) = (minutes(&quiet.start)?, minutes(&quiet.end)?);
    if start == end {
        return None;
    }
    let now = assistant.local_minutes(at);
    let inside = if start < end { now >= start && now < end } else { now >= start || now < end };
    if !inside {
        return None;
    }
    let wait = (end + 24 * 60 - now) % (24 * 60);
    Some(at - at % 60_000 + u64::from(wait) * 60_000)
}

/// Queue a notice unless it says nothing new. Returns whether it was queued.
pub fn notify(assistant: &mut PersonalAssistant, text: String, task_id: Option<String>, urgent: bool, fingerprint: String, now: u64) -> bool {
    if assistant.notices.iter().any(|n| n.fingerprint == fingerprint) {
        return false;
    }
    let human_here = assistant.messages.iter().rev().find(|m| m.role == "human").is_some_and(|m| now.saturating_sub(m.at) < ACTIVE_MS);
    let mut deliver_at = if urgent { now } else { now + DIGEST_MS };
    if let Some(end) = quiet_until(assistant, deliver_at) {
        deliver_at = end;
    }
    let id = assistant.next_notice_id();
    assistant.notices.push(Notice {
        id, text, task_id, urgent, at: now, deliver_at,
        // Already on screen: record it so it isn't repeated, but don't ping.
        delivered_at: human_here.then_some(now), seen_at: human_here.then_some(now),
        fingerprint,
    });
    if assistant.notices.len() > MAX_NOTICES {
        let extra = assistant.notices.len() - MAX_NOTICES;
        assistant.notices.drain(..extra);
    }
    true
}

/// Mark due notices delivered. Several non-urgent ones become one digest
/// line in the conversation. Returns what to push to the phone.
pub fn deliver_due(assistant: &mut PersonalAssistant, now: u64) -> Vec<Notice> {
    let due: Vec<usize> = assistant.notices.iter().enumerate()
        .filter(|(_, n)| n.delivered_at.is_none() && n.deliver_at <= now)
        .map(|(i, _)| i).collect();
    if due.is_empty() {
        return vec![];
    }
    // A non-urgent notice that's due pulls the other pending ones forward,
    // unless quiet hours hold them.
    let mut out = Vec::new();
    for i in due {
        assistant.notices[i].delivered_at = Some(now);
        out.push(assistant.notices[i].clone());
    }
    let calm: Vec<&Notice> = out.iter().filter(|n| !n.urgent).collect();
    if calm.len() > 1 {
        let lines: Vec<String> = calm.iter().map(|n| format!("- {}", n.text)).collect();
        assistant.post("assistant", "notice", format!("While you were away:\n{}", lines.join("\n")), None, None, now);
    }
    out
}

/// The next time a held notice is due.
pub fn next_due(assistant: &PersonalAssistant) -> Option<u64> {
    assistant.notices.iter().filter(|n| n.delivered_at.is_none()).map(|n| n.deliver_at).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal::QuietHours;

    pub(crate) fn blank() -> PersonalAssistant {
        serde_json::from_value(serde_json::json!({
            "id": "asst-1", "name": "A", "style": "", "hostId": "h", "profile": null, "allowedFolders": [],
            "paused": false, "revision": 1, "createdAt": 0, "counters": {"message":0,"event":0,"task":0,"decision":0},
            "messages": [], "events": [], "tasks": []
        })).unwrap()
    }

    #[test]
    fn the_same_result_is_announced_once() {
        let mut a = blank();
        assert!(notify(&mut a, "Disk 80%".into(), None, false, "result:pt-1:abc".into(), 1_000));
        assert!(!notify(&mut a, "Disk 80%".into(), None, false, "result:pt-1:abc".into(), 5_000));
        assert!(!notify(&mut a, "Disk at 80%".into(), None, false, "result:pt-1:abc".into(), 9_000));
        assert_eq!(a.notices.len(), 1);
    }

    #[test]
    fn quiet_hours_hold_a_notice_until_they_end() {
        let mut a = blank();
        a.quiet_hours = Some(QuietHours { start: "22:00".into(), end: "07:00".into() });
        let at_23 = 23 * 3_600_000;
        assert!(notify(&mut a, "Done".into(), None, true, "x".into(), at_23));
        assert_eq!(a.notices[0].deliver_at, 24 * 3_600_000 + 7 * 3_600_000);
        assert!(deliver_due(&mut a, at_23 + 60_000).is_empty());
        assert_eq!(deliver_due(&mut a, 31 * 3_600_000).len(), 1);
    }
}
