//! Defensive decoding and presentation helpers for host turn-progress records.
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelineItem {
    Text(String),
    Activity(Vec<String>),
}

/// Read a structured timeline. Invalid entries are ignored; text is always
/// rendered through the CLI's existing terminal sanitizer at the call site.
pub fn timeline(value: &Value) -> Vec<TimelineItem> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item["kind"].as_str()? {
            "text" => item["text"]
                .as_str()
                .map(|s| TimelineItem::Text(s.to_owned())),
            "activity" => item["keys"].as_array().map(|keys| {
                TimelineItem::Activity(
                    keys.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                )
            }),
            _ => None,
        })
        .collect()
}

pub fn step_label(step: &Value) -> Option<&'static str> {
    if step["parent"].is_string() { return None; }
    kind_label(step)
}

pub fn kind_label(step: &Value) -> Option<&'static str> {
    match step["kind"].as_str()? {
        "command" => Some("Ran command"),
        "read" => Some("Read file"),
        "list" => Some("Listed files"),
        "write" | "edit" => Some("Edited file"),
        "search" => Some("Searched"),
        "web" => Some("Used web"),
        "tool" => Some("Used tool"),
        "helper" | "agent" | "delegate" => Some("Delegated work"),
        "thinking" | "other" => Some("Worked"),
        _ => None,
    }
}

pub fn referenced_steps<'a>(detail: &'a Value, keys: &[String]) -> Vec<&'a Value> {
    let steps=detail["steps"].as_array();
    keys.iter().filter_map(|key| steps.and_then(|rows|rows.iter().find(|step|step["key"]==*key))).filter(|step|step_label(step).is_some()).collect()
}

/// A compact account of one actual activity group, without counting helper children twice.
pub fn summary(detail: &Value, keys: &[String]) -> String {
    let steps = referenced_steps(detail, keys);
    let mut groups: Vec<(&str, usize)> = Vec::new();
    for step in &steps {
        let kind = step["kind"].as_str().unwrap_or("other");
        if let Some((_, count)) = groups.iter_mut().find(|(known, _)| *known == kind) {
            *count += 1;
        } else {
            groups.push((kind, 1));
        }
    }
    let mut label = groups.into_iter().map(|(kind, count)| {
        let (verb, one, many) = match kind {
            "read" => ("Read", "file", "files"),
            "command" => ("ran", "command", "commands"),
            "edit" | "write" => ("Edited", "file", "files"),
            "search" => ("Searched", "query", "queries"),
            "list" => ("Listed", "folder", "folders"),
            "web" => ("Browsed", "page", "pages"),
            "helper" | "agent" | "delegate" => ("Delegated", "task", "tasks"),
            "tool" => ("Used", "tool", "tools"),
            _ => ("Performed", "action", "actions"),
        };
        format!("{verb} {count} {}", if count == 1 { one } else { many })
    }).collect::<Vec<_>>().join(", ");
    if label.is_empty() { label.push_str("Activity"); }
    for (status, word) in [("failed", "failed"), ("running", "working"), ("stopped", "stopped")] {
        let count = steps.iter().filter(|step| step["status"] == status).count();
        if count > 0 { label.push_str(&format!(" · {count} {word}")); }
    }
    label
}

pub fn completed(todo: &Value) -> (usize, usize) {
    let rows = todo.as_array().cloned().unwrap_or_default();
    let done = rows
        .iter()
        .filter(|row| {
            matches!(
                row["status"].as_str(),
                Some("completed" | "complete" | "done")
            )
        })
        .count();
    (done, rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timeline_keeps_order_and_ignores_malformed_items() {
        let value = json!([
            {"kind":"text","text":"Checking files"},
            {"kind":"activity","keys":["read_file","alien_tool"]},
            {"kind":"text","text":"Done"},
            {"kind":"other","text":"ignored"},
            {"kind":"activity","keys":3}
        ]);
        assert_eq!(
            timeline(&value),
            vec![
                TimelineItem::Text("Checking files".into()),
                TimelineItem::Activity(vec!["read_file".into(), "alien_tool".into()]),
                TimelineItem::Text("Done".into())
            ]
        );
    }

    #[test]
    fn summary_groups_top_level_steps_and_reports_actual_status() {
        let detail = json!({"steps":[
            {"key":"a","kind":"read","parent":null,"status":"done"},
            {"key":"b","kind":"read","parent":null,"status":"done"},
            {"key":"c","kind":"command","parent":null,"status":"failed"},
            {"key":"d","kind":"tool","parent":"c","status":"done"}
        ]});
        assert_eq!(summary(&detail, &["a".into(),"b".into(),"c".into(),"d".into()]), "Read 2 files, ran 1 command · 1 failed");
    }

    #[test]
    fn todo_counts_completed_statuses_without_assuming_shape() {
        assert_eq!(
            completed(&json!([{"status":"completed"},{"status":"in_progress"},{"status":"done"}])),
            (2, 3)
        );
        assert_eq!(completed(&json!(null)), (0, 0));
    }

    #[test]
    fn tool_reference_resolves_known_type_and_ignores_nested_helpers() {
        let detail=json!({"steps":[{"key":"x","kind":"web","parent":null,"label":"search"},{"key":"secret","kind":"tool","parent":"x","label":"nested"}]});
        assert_eq!(step_label(&detail["steps"][0]),Some("Used web"));
        assert!(referenced_steps(&detail,&["secret".into()]).is_empty());
    }
}

fn empty_record(id: &str) -> Value {
    serde_json::json!({"by":id,"seq":0,"steps":[],"todo":[],"timeline":[],"dropped":0})
}

/// Initialize older checkpoints without losing their active participants.
pub fn restore(records: &mut Value, active: &[Value]) {
    use serde_json::json;
    if !records.is_object() { *records = json!({}); }
    let records = records.as_object_mut().expect("progress map initialized");
    for id in active.iter().filter_map(Value::as_str) {
        records.entry(id.to_owned()).or_insert_with(|| empty_record(id));
    }
    for (id, record) in records.iter_mut() {
        if !record.is_object() { *record = empty_record(id); }
        for field in ["steps", "todo", "timeline"] {
            if !record[field].is_array() { record[field] = json!([]); }
        }
        if !record["dropped"].is_number() { record["dropped"] = json!(0); }
    }
}

fn finish(record: &mut Value, outcome: &str) {
    if record["outcome"].is_string() { return; }
    record["outcome"] = Value::String(outcome.into());
    for step in record["steps"].as_array_mut().into_iter().flatten() {
        if step["status"] == "running" { step["status"] = Value::String("stopped".into()); }
    }
}

/// Apply actual progress events, retaining unfinished terminal records and tool identity.
pub fn reduce(records: &mut Value, event: &Value) {
    use serde_json::json;
    let kind = event["type"].as_str().unwrap_or("");
    if !records.is_object() { *records = json!({}); }
    let records = records.as_object_mut().expect("progress map initialized");
    if kind == "message_added" {
        if event["message"]["speaker"]["kind"] == "bot" {
            if let Some(id) = event["message"]["speaker"]["id"].as_str() { records.remove(id); }
        }
        return;
    }
    if matches!(kind, "idle" | "stopped") {
        for record in records.values_mut() { finish(record, "stopped"); }
        return;
    }
    let Some(id) = event["id"].as_str() else { return; };
    if kind == "turn_started" { records.insert(id.into(), empty_record(id)); return; }
    if !matches!(kind, "delta" | "todo" | "work_step" | "failed" | "passed" | "participant_idle") { return; }
    let Some(record) = records.get_mut(id) else { return; };
    if !record.is_object() { *record = empty_record(id); }
    for field in ["steps", "todo", "timeline"] {
        if !record[field].is_array() { record[field] = json!([]); }
    }
    if matches!(kind, "failed" | "passed" | "participant_idle") {
        finish(record, match kind { "failed" => "failed", "passed" => "passed", _ => "stopped" });
        return;
    }
    if record["outcome"].is_string() { return; }
    match kind {
        "delta" => {
            let text = event["text"].as_str().unwrap_or("");
            let used: usize = record["timeline"].as_array().unwrap().iter().filter_map(|item| item["text"].as_str()).map(str::len).sum();
            let mut end = text.len().min((256usize * 1024).saturating_sub(used));
            if end < text.len() { record["timeline_cut"] = json!(true); }
            while !text.is_char_boundary(end) { end -= 1; }
            if end == 0 { return; }
            let timeline = record["timeline"].as_array_mut().unwrap();
            if let Some(last) = timeline.last_mut().filter(|last| last["kind"] == "text") {
                let before = last["text"].as_str().unwrap_or("");
                last["text"] = json!(format!("{before}{}", &text[..end]));
            } else { timeline.push(json!({"kind":"text","text":&text[..end]})); }
        }
        "todo" => { if event["items"].is_array() { record["todo"] = event["items"].clone(); } }
        "work_step" => {
            let mut step = event["step"].clone();
            let Some(key) = step["key"].as_str().map(str::to_owned) else { return; };
            let steps = record["steps"].as_array_mut().unwrap();
            let is_new = !steps.iter().any(|old| old["key"] == key);
            if let Some(old) = steps.iter_mut().find(|old| old["key"] == key) {
                if step["output"].as_str().is_none_or(str::is_empty) && old["output"].is_string() {
                    step["output"] = old["output"].clone();
                    step["output_cut"] = old["output_cut"].clone();
                }
                *old = step.clone();
            } else if steps.len() < 2_000 { steps.push(step.clone()); }
            else {
                record["dropped"] = json!(record["dropped"].as_u64().unwrap_or(0).saturating_add(1));
                return;
            }
            if is_new && step["parent"].is_null() {
                let timeline = record["timeline"].as_array_mut().unwrap();
                if let Some(last) = timeline.last_mut().filter(|last| last["kind"] == "activity") {
                    if let Some(keys) = last["keys"].as_array_mut() { keys.push(json!(key)); }
                } else { timeline.push(json!({"kind":"activity","keys":[key]})); }
            }
        }
        _ => {}
    }
}
