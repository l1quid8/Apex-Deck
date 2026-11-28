//! Bounded data expressions for Code Mode. No I/O or executable model code.
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub(super) const VALUE_MAX: usize = 1_048_576;
pub(super) const OUTPUT_MAX: usize = 16_384;

/// Most child calls one batch may run, however its plan spells them.
pub(super) const CALLS_MAX: usize = 128;

/// Why a call has no result. Fixed words only: a child's own error text may
/// hold private content, so it stays with its visible work step.
pub(super) const REFUSED: &str = "was refused permission";
pub(super) const FAILED: &str = "failed";
pub(super) const BLOCKED: &str = "was blocked";
pub(super) const TOO_LARGE: &str = "returned more than one batch may keep";

/// Each call that has run or been skipped: its result, or why there is none.
pub(super) type Results = HashMap<String, Result<Value, &'static str>>;

pub(super) struct Call<'a> {
    pub id: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
    /// A list to walk. The call runs once per item, with `$item` in its
    /// args standing for that item, so a plan stays short however many
    /// files it covers.
    pub for_each: Option<&'a Value>,
}

pub(super) struct Plan<'a> {
    pub stages: Vec<Vec<Call<'a>>>,
    pub output: &'a Value,
}

pub(super) fn validate(value: &Value) -> Result<Plan<'_>, String> {
    if value.to_string().len() > 65_536 {
        return Err("plan exceeds 64KiB".into());
    }
    let stages = value["stages"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("stages must be a nonempty array of arrays")?;
    let output = value.get("output").ok_or("output expression is required")?;
    let mut available = HashSet::new();
    let mut count = 0;
    let mut validated = Vec::new();
    for (index, stage) in stages.iter().enumerate() {
        let stage = stage.as_array().ok_or_else(|| format!(
            "stages[{index}] must be an array of calls. Use stages=[[{{id,tool,args}}]], not stages=[{{id,tool,args}}]"
        ))?;
        if stage.is_empty() {
            return Err(format!("stages[{index}] must not be empty"));
        }
        let mut ids = HashSet::new();
        let mut calls = Vec::new();
        for call in stage {
            let for_each = call.get("forEach");
            // A written-out list is counted now; one that only exists at run
            // time is held to the same limit when it is expanded. Empty lists
            // still occupy a plan/trace slot, so they cannot bypass the cap.
            count += for_each.and_then(Value::as_array).map_or(1, |items| items.len().max(1));
            if count > CALLS_MAX {
                return Err("at most 128 calls are allowed, counting every forEach item".into());
            }
            let id = call["id"]
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 40
                        && id.bytes().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-'
                        })
                })
                .ok_or("call id must be 1-40 lowercase letters, digits, underscores or hyphens")?;
            if available.contains(id) || !ids.insert(id) {
                return Err("duplicate call id".into());
            }
            let tool = call["tool"]
                .as_str()
                .filter(|name| super::TOOLS.contains(name))
                .ok_or("unknown tool; only the six documented file tools are allowed")?;
            if matches!(tool, "write_file" | "edit_file") && stage.len() != 1 {
                return Err("writes require an isolated stage".into());
            }
            let args = call
                .get("args")
                .filter(|a| a.is_object())
                .ok_or("call args must be an object")?;
            if let Some(list) = for_each {
                if matches!(tool, "write_file" | "edit_file") {
                    return Err("forEach is for read tools; give each write its own stage".into());
                }
                let yields_list = list.is_array()
                    || list.get("$ref").is_some()
                    || list.get("$collect").is_some();
                if !yields_list {
                    return Err("forEach must be an array, or a $ref/$collect expression that yields one".into());
                }
                validate_expression(list, &available, 0, false)?;
            }
            validate_expression(args, &available, 0, for_each.is_some())?;
            calls.push(Call { id, tool, args, for_each });
        }
        available.extend(ids);
        validated.push(calls);
    }
    validate_expression(output, &available, 0, false)?;
    Ok(Plan {
        stages: validated,
        output,
    })
}

fn validate_path(path: Option<&Value>) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    let path = path
        .as_array()
        .filter(|v| v.len() <= 16)
        .ok_or("reference path must have at most 16 keys")?;
    if path
        .iter()
        .any(|k| !k.is_string() && !k.is_i64() && !k.is_u64())
    {
        return Err("reference path keys must be strings or integers".into());
    }
    Ok(())
}

fn validate_expression(
    value: &Value,
    available: &HashSet<&str>,
    depth: usize,
    item: bool,
) -> Result<(), String> {
    if depth > 32 {
        return Err("expression depth exceeds 32".into());
    }
    if let Some(marker) = value.get("$item") {
        if !item {
            return Err("$item is only valid inside the args of a call that has forEach".into());
        }
        if marker != &Value::Bool(true) {
            return Err("write the current forEach item as {\"$item\":true}".into());
        }
        return validate_path(value.get("path"));
    }
    if value.get("$ref").is_some() && value.get("$collect").is_some() {
        return Err("an expression cannot contain both $ref and $collect".into());
    }
    if let Some(reference) = value.get("$ref") {
        let reference = reference.as_str().ok_or("$ref must be a call id")?;
        if !available.contains(reference) {
            return Err("$ref must name a call from an earlier stage".into());
        }
        validate_path(value.get("path"))?;
        return validate_pipe(value.get("pipe"));
    }
    if let Some(collection) = value.get("$collect") {
        let collection = collection
            .as_array()
            .filter(|v| v.len() <= 128)
            .ok_or("$collect must be an array of at most 128 expressions")?;
        validate_pipe(value.get("pipe"))?;
        for child in collection {
            validate_expression(child, available, depth + 1, item)?;
        }
    } else {
        match value {
            Value::Array(values) => {
                for child in values {
                    validate_expression(child, available, depth + 1, item)?;
                }
            }
            Value::Object(values) => {
                for child in values.values() {
                    validate_expression(child, available, depth + 1, item)?;
                }
            }
            _ => (),
        }
    }
    Ok(())
}

fn validate_pipe(pipe: Option<&Value>) -> Result<(), String> {
    let Some(pipe) = pipe else {
        return Ok(());
    };
    let pipe = pipe
        .as_array()
        .filter(|v| v.len() <= 8)
        .ok_or("pipe must be an array of at most 8 filters")?;
    for op in pipe {
        match op["op"].as_str() {
            Some("jsonLines") => {
                if op["prefix"].as_str().filter(|s| !s.is_empty()).is_none() {
                    return Err("jsonLines requires a nonempty prefix".into());
                }
            }
            Some("fieldEquals") => {
                if op["field"].as_str().is_none_or(str::is_empty)
                    || !op
                        .get("value")
                        .is_some_and(|v| !v.is_array() && !v.is_object())
                {
                    return Err("fieldEquals requires a field name and a scalar value".into());
                }
            }
            Some("pick") => {
                if op["fields"]
                    .as_array()
                    .filter(|v| v.len() <= 32 && v.iter().all(Value::is_string))
                    .is_none()
                {
                    return Err("pick requires at most 32 string fields".into());
                }
            }
            Some("sum") => {
                if op.get("field").is_some_and(|v| !v.is_string()) {
                    return Err("sum field must be a string".into());
                }
            }
            Some("length" | "lines") => (),
            _ => return Err("unknown filter; use lines, jsonLines, fieldEquals, pick, sum or length".into()),
        }
    }
    Ok(())
}

fn bounded(value: Value) -> Result<Value, String> {
    if value.to_string().len() > VALUE_MAX {
        Err("intermediate value is over 1MiB; filter it further".into())
    } else {
        Ok(value)
    }
}

// Check each appended value before building a potentially multiplied collection.
fn account(total: &mut usize, value: &Value) -> Result<(), String> {
    *total += value.to_string().len() + 1;
    if *total > VALUE_MAX {
        Err("intermediate value is over 1MiB; filter it further".into())
    } else {
        Ok(())
    }
}

/// What a value is, for an error. Never the value: results may be private.
fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

fn follow<'a>(mut selected: &'a Value, path: Option<&Value>) -> Result<&'a Value, String> {
    for key in path.and_then(Value::as_array).into_iter().flatten() {
        selected = field(selected, key)?;
    }
    Ok(selected)
}

/// Work an expression out. `item` is the current forEach item, when the
/// expression is the args of a call that walks a list.
pub(super) fn resolve(
    value: &Value,
    results: &Results,
    item: Option<&Value>,
) -> Result<Value, String> {
    if value.get("$item").is_some() {
        let item = item.ok_or("$item is only available inside forEach args")?;
        return bounded(follow(item, value.get("path"))?.clone());
    }
    if let Some(reference) = value.get("$ref") {
        let id = reference.as_str().ok_or("invalid reference")?;
        let selected = match results.get(id) {
            Some(Ok(selected)) => selected,
            Some(Err(why)) => return Err(format!("call \"{id}\" {why}, so its result is unavailable")),
            None => return Err(format!("call \"{id}\" did not run, so its result is unavailable")),
        };
        let selected = follow(selected, value.get("path"))?;
        return pipe(selected, value.get("pipe")).map_err(|why| format!("$ref \"{id}\": {why}"));
    }
    if let Some(collection) = value.get("$collect").and_then(Value::as_array) {
        let collected = resolve_array(collection, results, item)?;
        return pipe(&collected, value.get("pipe")).map_err(|why| format!("$collect: {why}"));
    }
    match value {
        Value::Array(array) => resolve_array(array, results, item),
        Value::Object(object) => {
            let mut resolved = Map::new();
            let mut size = 2;
            for (key, child) in object {
                let child = resolve(child, results, item)?;
                size += json!(key).to_string().len() + 1;
                account(&mut size, &child)?;
                resolved.insert(key.clone(), child);
            }
            Ok(Value::Object(resolved))
        }
        _ => bounded(value.clone()),
    }
}

/// Work the output out part by part. An object or list written out in the
/// plan is a set of independent parts: one that cannot be worked out becomes
/// null and is recorded in `lost` with where it was and why, and the rest
/// are returned. A `$ref` or `$collect` is one part, all or nothing, so a
/// filter never totals a list with a hole in it.
pub(super) fn resolve_output(
    value: &Value,
    results: &Results,
    lost: &mut Vec<(String, String)>,
) -> Result<Value, String> {
    let whole = !(value.is_array() || value.is_object()) || is_expression(value);
    if whole {
        return resolve(value, results, None);
    }
    parts(value, results, "output", lost, &mut 0)
}

fn is_expression(value: &Value) -> bool {
    ["$ref", "$collect", "$item"].iter().any(|key| value.get(key).is_some())
}

fn parts(
    value: &Value,
    results: &Results,
    at: &str,
    lost: &mut Vec<(String, String)>,
    size: &mut usize,
) -> Result<Value, String> {
    let part = if is_expression(value) {
        resolve(value, results, None).unwrap_or_else(|why| {
            lost.push((at.to_owned(), why));
            Value::Null
        })
    } else {
        match value {
            Value::Array(values) => {
                let mut resolved = Vec::new();
                for (index, child) in values.iter().enumerate() {
                    resolved.push(parts(child, results, &format!("{at}[{index}]"), lost, size)?);
                }
                return Ok(Value::Array(resolved));
            }
            Value::Object(values) => {
                let mut resolved = Map::new();
                for (key, child) in values {
                    let child = parts(child, results, &format!("{at}.{key}"), lost, size)?;
                    resolved.insert(key.clone(), child);
                }
                return Ok(Value::Object(resolved));
            }
            other => other.clone(),
        }
    };
    // Stop as soon as the parts together are too big to return, before
    // many individually bounded values pile up.
    *size += part.to_string().len();
    if *size > OUTPUT_MAX {
        return Err("the output is over 16KiB; filter it further".into());
    }
    Ok(part)
}

fn resolve_array(
    values: &[Value],
    results: &Results,
    item: Option<&Value>,
) -> Result<Value, String> {
    let mut resolved = Vec::new();
    let mut size = 2;
    for child in values {
        let child = resolve(child, results, item)?;
        account(&mut size, &child)?;
        resolved.push(child);
    }
    Ok(Value::Array(resolved))
}

fn field<'a>(value: &'a Value, key: &Value) -> Result<&'a Value, String> {
    match value {
        Value::Object(map) => {
            let key = key
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| key.to_string());
            map.get(&key).ok_or_else(|| format!("no field \"{key}\""))
        }
        Value::Array(array) => {
            let index = key
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .or_else(|| key.as_str()?.parse::<usize>().ok())
                .ok_or_else(|| format!("{key} is not a list position"))?;
            array.get(index).ok_or_else(|| format!("the list has no position {index}"))
        }
        other => Err(format!("cannot look up {key} in {}", kind(other))),
    }
}

/// Run the filters left to right. A failure names its filter and says what
/// it was given, so the plan can be corrected in one go.
fn pipe(value: &Value, operations: Option<&Value>) -> Result<Value, String> {
    // A forEach result can be far larger than one value may be; the first
    // filter reads it in place and every later value is bounded.
    let mut current: Option<Value> = None;
    for op in operations.and_then(Value::as_array).into_iter().flatten() {
        let name = op["op"].as_str().unwrap_or("unknown");
        let next = filter(current.as_ref().unwrap_or(value), op)
            .map_err(|why| format!("{name} filter: {why}"))?;
        current = Some(next);
    }
    match current {
        Some(value) => bounded(value),
        // Measure before copying: an unfiltered forEach result may be large.
        None if value.to_string().len() > VALUE_MAX => {
            Err("the value is over 1MiB; add filters to cut it down".into())
        }
        None => Ok(value.clone()),
    }
}

/// The texts a line filter reads: one text, or every text of a forEach
/// result, which then gives one flat list across all of its items.
fn texts(value: &Value) -> Result<Vec<&str>, String> {
    match value {
        Value::String(text) => Ok(vec![text]),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                item.as_str().ok_or_else(|| {
                    format!("item {index} is {}; expected text or a list of texts", kind(item))
                })
            })
            .collect(),
        other => Err(format!("got {}; expected text or a list of texts", kind(other))),
    }
}

fn filter(value: &Value, op: &Value) -> Result<Value, String> {
    match op["op"].as_str() {
        Some("lines") => {
            let mut rows = Vec::new();
            let mut size = 2;
            for text in texts(value)? {
                for line in text.split('\n').map(|l| l.trim_end_matches('\r')) {
                    if !line.is_empty() {
                        let row = json!(line);
                        account(&mut size, &row)?;
                        rows.push(row);
                    }
                }
            }
            Ok(Value::Array(rows))
        }
        Some("jsonLines") => {
            let prefix = op["prefix"].as_str().ok_or("missing prefix")?;
            let mut rows = Vec::new();
            let mut size = 2;
            for text in texts(value)? {
                for line in text.split('\n') {
                    if let Some(json) = line.strip_prefix(prefix) {
                        let row: Value = serde_json::from_str(json)
                            .map_err(|_| "a line with the prefix is not followed by valid JSON")?;
                        account(&mut size, &row)?;
                        rows.push(row);
                    }
                }
            }
            Ok(Value::Array(rows))
        }
        Some("fieldEquals") => {
            let rows = value
                .as_array()
                .ok_or("fieldEquals expects a list of rows")?;
            let key = op["field"].as_str().ok_or("invalid field")?;
            let mut matches = Vec::new();
            let mut size = 2;
            for (index, row) in rows.iter().enumerate() {
                let fields = row
                    .as_object()
                    .ok_or_else(|| format!("row {index}: expected an object"))?;
                if fields.get(key) == op.get("value") {
                    account(&mut size, row)?;
                    matches.push(row.clone());
                }
            }
            Ok(Value::Array(matches))
        }
        Some("pick") => {
            let fields = op["fields"].as_array().ok_or("invalid fields")?;
            let pick = |row: &Value| -> Result<Value, String> {
                let mut selected = Map::new();
                let mut size = 2;
                for key in fields {
                    let value = field(row, key)?;
                    size += key.to_string().len() + 1;
                    account(&mut size, value)?;
                    selected.insert(key.as_str().ok_or("invalid field")?.into(), value.clone());
                }
                Ok(Value::Object(selected))
            };
            if let Value::Array(rows) = value {
                let mut selected = Vec::new();
                let mut size = 2;
                for (index, row) in rows.iter().enumerate() {
                    let row = pick(row).map_err(|why| format!("row {index}: {why}"))?;
                    account(&mut size, &row)?;
                    selected.push(row);
                }
                Ok(Value::Array(selected))
            } else {
                pick(value)
            }
        }
        Some("sum") => {
            let rows = value
                .as_array()
                .ok_or_else(|| format!("got {}; expected a list", kind(value)))?;
            let mut total = 0.0;
            for (index, row) in rows.iter().enumerate() {
                let number = match op.get("field") {
                    // The usual slip: $collect of per-call rows is a list of
                    // lists, which has no fields to add up.
                    Some(key) if row.is_array() => {
                        return Err(format!(
                            "item {index} is a list, not a row with field {key}; sum each list first, or use jsonLines on a forEach result for one flat list"
                        ));
                    }
                    Some(key) => field(row, key).map_err(|why| format!("row {index}: {why}"))?,
                    None => row,
                };
                total += number
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| format!("item {index} is {}; expected a number", kind(number)))?;
                if !total.is_finite() {
                    return Err("the total overflowed".into());
                }
            }
            // Match the JSON prototype's integer representation for whole sums.
            serde_json::from_str(&total.to_string()).map_err(|_| "the total overflowed".into())
        }
        Some("length") => match value {
            Value::Array(rows) => Ok(json!(rows.len())),
            // The prototype counts JS UTF-16 code units, not UTF-8 bytes.
            Value::String(text) => Ok(json!(text.encode_utf16().count())),
            other => Err(format!("got {}; expected text or a list", kind(other))),
        },
        _ => Err("unknown filter".into()),
    }
}

#[cfg(test)]
mod field_equals_tests {
    use super::*;

    #[test]
    fn conditional_count_and_sum_preserve_types_and_skip_missing_fields() {
        let rows = json!([{"x":"1","n":5},{"x":1,"n":11},{"n":17},{"x":null,"n":3}]);
        for (value, count, sum) in [
            (json!("1"), 1, 5.0),
            (json!(null), 1, 3.0),
            (json!("unknown"), 0, 0.0),
        ] {
            let op = json!({"op":"fieldEquals","field":"x","value":value});
            validate_pipe(Some(&json!([op]))).unwrap();
            let selected = filter(&rows, &op).unwrap();
            assert_eq!(filter(&selected, &json!({"op":"length"})).unwrap(), count);
            assert_eq!(
                filter(&selected, &json!({"op":"sum","field":"n"})).unwrap(),
                sum
            );
        }
        assert!(validate_pipe(Some(&json!([{"op":"fieldEquals","field":"x"}]))).is_err());
    }
}
