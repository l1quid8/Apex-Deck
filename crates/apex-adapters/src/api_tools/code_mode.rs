//! Deck-owned bounded JSON orchestration. No child runtime or model code.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[path = "code_mode_plan.rs"]
mod expressions;

const TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "write_file",
    "edit_file",
];
const RETAINED_MAX: usize = 8_388_608;
const REPORT_MAX: usize = 28_000;
/// Most missing output parts a report spells out; the rest are counted.
const UNAVAILABLE_MAX: usize = 16;

pub(super) fn definition() -> Value {
    tool(
        "deck_code_mode",
        "Run file tools as one batch inside Deck and get back only a filtered result, so raw file contents stay out of your context. Keep the plan short: to run one tool over many files, write ONE call with forEach, never a call per file. Example, reading three files to count their RECORD lines and total a field: {\"stages\":[[{\"id\":\"r\",\"tool\":\"read_file\",\"forEach\":[\"a.txt\",\"b.txt\",\"c.txt\"],\"args\":{\"path\":{\"$item\":true}}}]],\"output\":{\"count\":{\"$ref\":\"r\",\"pipe\":[{\"op\":\"jsonLines\",\"prefix\":\"RECORD \"},{\"op\":\"length\"}]},\"total\":{\"$ref\":\"r\",\"pipe\":[{\"op\":\"jsonLines\",\"prefix\":\"RECORD \"},{\"op\":\"sum\",\"field\":\"units\"}]}}}. The list may come from an earlier stage: after [{\"id\":\"found\",\"tool\":\"glob\",\"args\":{\"pattern\":\"*.txt\"}}], use \"forEach\":{\"$ref\":\"found\",\"pipe\":[{\"op\":\"lines\"}]}. Independent reads run up to four at a time and every child call gets its normal permission check. Writes go one per stage, in order, and cannot use forEach. No shell, MCP, computer, nested batches or JavaScript. A failed child or filter gives status partial; nothing is rolled back. Each part of an output object or list stands alone: a part that needs a refused, failed or blocked call comes back null and is listed under unavailable with the reason, and the other parts are still returned. A step the person or the access level refused has status refused; do not retry it. read_file results have their line-number prefixes removed; normal truncation limits apply. Intermediates are kept for this batch only.",
        object(
            json!({
                "stages": {"type":"array", "minItems":1, "maxItems":128, "description":"ARRAY OF ARRAYS: stages=[[call,...],[...]]. Each stage is an array, never an object. A call is {id,tool,args}, or {id,tool,forEach,args} to run once per list item. Tools: read_file,list_dir,glob,grep,write_file,edit_file, with their ordinary args. At most 128 child calls counting every forEach item, and a 64KiB plan. A write must be alone in its stage.", "items":{"type":"array","minItems":1,"maxItems":128,"items":object(json!({"id":{"type":"string","pattern":"^[a-z0-9_-]{1,40}$"},"tool":{"type":"string","enum":TOOLS},"forEach":{"description":"Optional, read tools only. A list, or a $ref/$collect expression from an earlier stage that yields one. The call runs once per item, {\"$item\":true} in args standing for the item, and its result is the list of per-item results in order."},"args":{"type":"object"}}), &["id","tool","args"]) }},
                "output": {"description":"JSON expression built from literals, arrays, objects, {$ref:id,path?:[keys],pipe?:[filters]} and {$collect:[expressions],pipe?:[filters]}. A plain call's result is its text; a forEach call's result is a list of texts. Filters run left to right: {op:lines} gives the non-empty lines; {op:jsonLines,prefix:string} gives the JSON that follows the prefix on each matching line, as rows; on a list of texts both give ONE flat list across all items. {op:pick,fields:[names]} keeps those fields of each row; {op:sum,field?:name} adds numbers, or one field of each row; {op:length} counts a list or text. Refs in args may only name earlier stages; output may use any call. Max output 16KiB."}
            }),
            &["stages", "output"],
        ),
    )
}

/// A whole plan followed only by closing brackets it doesn't need. Deeply
/// nested plans draw that slip, and refusing one costs the model a full
/// rewrite. Nothing else is forgiven, and no other tool is read this way.
pub(super) fn complete_plan(call: &ToolCall) -> Option<Value> {
    if call.name != "deck_code_mode" {
        return None;
    }
    let mut values = serde_json::Deserializer::from_str(&call.arguments).into_iter::<Value>();
    let plan = values.next()?.ok().filter(Value::is_object)?;
    call.arguments[values.byte_offset()..]
        .chars()
        .all(|c| c.is_whitespace() || matches!(c, '}' | ']'))
        .then_some(plan)
}

impl Turn<'_> {
    pub(super) async fn code_mode(
        &mut self,
        parent: &ToolCall,
        value: &Value,
    ) -> Result<Done, String> {
        // Off/Stop drops this future. Settle child rows as well as dropping
        // their approval futures, so the UI cannot retain a running batch child.
        struct ActiveSteps<'a> {
            steps: std::sync::Mutex<std::collections::BTreeMap<String, WorkStep>>,
            progress: ProgressSink<'a>,
        }
        impl Drop for ActiveSteps<'_> {
            fn drop(&mut self) {
                for (_, mut step) in std::mem::take(self.steps.get_mut().unwrap()) {
                    step.status = StepStatus::Stopped;
                    (self.progress)(Progress::Work(&step));
                }
            }
        }
        let active = ActiveSteps { steps: Default::default(), progress: self.progress };
        let progress = |update: Progress<'_>| {
            if let Progress::Work(step) = &update {
                let mut steps = active.steps.lock().unwrap();
                if step.status == StepStatus::Running { steps.insert(step.key.clone(), (*step).clone()); }
                else { steps.remove(&step.key); }
            }
            (self.progress)(update);
        };
        let mut batch = Turn {
            tools: self.tools, access: self.access, plan: self.plan, own: self.own,
            can_read_images: self.can_read_images, trusted_computer: self.trusted_computer,
            approver: self.approver, progress: &progress, jobs: shell::Jobs::default(),
            servers: self.servers.clone(), cwd: self.cwd.clone(), roots: self.roots.clone(),
            refused: AtomicBool::new(false),
        };
        batch.execute_code_mode(parent, value).await
    }

    async fn execute_code_mode(
        &mut self,
        parent: &ToolCall,
        value: &Value,
    ) -> Result<Done, String> {
        // A plan wrapped the way the API wraps a call is still that plan.
        let value = match value.as_object() {
            Some(only) if only.len() == 1 && only.get("arguments").is_some_and(Value::is_object) => {
                &only["arguments"]
            }
            _ => value,
        };
        // Validate every stage AND expression before permitting any effect.
        let plan = expressions::validate(value).map_err(|why| {
            format!(
                "Invalid Code Mode plan: {why}. No children executed; correct the plan and retry."
            )
        })?;
        let started = Instant::now();
        let mut results = expressions::Results::new();
        let mut steps = Vec::new();
        let mut raw_bytes = 0;
        let mut index = 0;
        let mut peak = 0;
        for stage in &plan.stages {
            // Spell the stage out as child calls before any of them runs: one
            // per plain call, one per item of a forEach list. Every child is
            // an ordinary tool call with its own permission check.
            let mut traces = Vec::new();
            let mut slots: Vec<Vec<Option<String>>> = Vec::new();
            // Per call, the children a person or the access level refused.
            let mut denied: Vec<Vec<usize>> = Vec::new();
            let mut jobs = Vec::new();
            for (position, call) in stage.iter().enumerate() {
                let mut trace = json!({"id":call.id,"tool":call.tool,"status":"blocked"});
                let items = match call.for_each {
                    None => Ok(vec![None]),
                    Some(list) => match expressions::resolve(list, &results, None) {
                        Ok(Value::Array(items)) => Ok(items.into_iter().map(Some).collect()),
                        Ok(_) => Err("forEach did not yield a list".to_string()),
                        Err(why) => Err(format!("forEach: {why}")),
                    },
                };
                let items = items.and_then(|items: Vec<Option<Value>>| {
                    if index + items.len() > expressions::CALLS_MAX {
                        Err(format!(
                            "{} more child calls would take this batch past its limit of 128; narrow the list or split the work",
                            items.len()
                        ))
                    } else {
                        Ok(items)
                    }
                });
                let items = match items {
                    Ok(items) => items,
                    Err(why) => {
                        index += 1;
                        trace["error"] = json!(why);
                        traces.push(trace);
                        slots.push(Vec::new());
                        denied.push(Vec::new());
                        continue;
                    }
                };
                if call.for_each.is_some() {
                    trace["items"] = json!(items.len());
                }
                slots.push(vec![None; items.len()]);
                denied.push(Vec::new());
                // No child of a call runs unless all of its args resolve.
                let mut children = Vec::new();
                for (slot, item) in items.iter().enumerate() {
                    index += 1;
                    match expressions::resolve(call.args, &results, item.as_ref()) {
                        Ok(args) if args.is_object() => children.push((
                            position,
                            slot,
                            ToolCall {
                                id: format!("{}:batch:{index}", parent.id),
                                name: call.tool.into(),
                                arguments: args.to_string(),
                                extra: None,
                            },
                        )),
                        Ok(_) => trace["error"] = json!("args did not resolve to an object"),
                        Err(why) => trace["error"] = json!(why),
                    }
                }
                if trace.get("error").is_none() {
                    jobs.extend(children);
                }
                traces.push(trace);
            }
            // Only explicitly allowlisted stateless reads can overlap. Writes
            // have isolated stages and always run on this original Turn.
            for group in jobs.chunks(4) {
                tokio::task::yield_now().await;
                peak = peak.max(group.len());
                let replies = if group.len() == 1 {
                    let start = Instant::now();
                    self.refused.store(false, Ordering::Relaxed);
                    let (reply, ok) = Box::pin(self.run_checked(&group[0].2)).await;
                    vec![(reply, ok, self.refused.load(Ordering::Relaxed), millis(start))]
                } else {
                    // Exact authority snapshots, never independent permissions.
                    // The usual dispatcher still checks each resolved argument.
                    let children: Vec<_> = group
                        .iter()
                        .map(|_| Turn {
                            tools: self.tools,
                            access: self.access,
                            plan: self.plan,
                            own: self.own,
                            can_read_images: self.can_read_images,
                            trusted_computer: self.trusted_computer,
                            approver: self.approver,
                            progress: self.progress,
                            jobs: shell::Jobs::default(),
                            servers: self.servers.clone(),
                            cwd: self.cwd.clone(),
                            roots: self.roots.clone(),
                            refused: AtomicBool::new(false),
                        })
                        .collect();
                    futures::future::join_all(children.into_iter().zip(group).map(
                        |(mut turn, (_, _, call))| async move {
                            let start = Instant::now();
                            let (reply, ok) = Box::pin(turn.run_checked(call)).await;
                            (reply, ok, turn.refused.load(Ordering::Relaxed), millis(start))
                        },
                    ))
                    .await
                };
                for ((position, slot, _), (reply, ok, refused, ms)) in group.iter().zip(replies) {
                    let trace = &mut traces[*position];
                    // A forEach call reports the time its children took together.
                    let total = trace["ms"].as_f64().unwrap_or(0.0) + ms;
                    trace["ms"] = json!((total * 100.0).round() / 100.0);
                    // Failed child diagnostics belong to their visible work
                    // steps; do not feed them or unavailable values to filters.
                    if !ok {
                        if refused {
                            denied[*position].push(*slot);
                        }
                        continue;
                    }
                    let text = if stage[*position].tool == "read_file" {
                        unnumber(&reply.text)
                    } else {
                        reply.text
                    };
                    if json!(text).to_string().len() <= expressions::VALUE_MAX {
                        slots[*position][*slot] = Some(text);
                    }
                }
            }
            // A call has a result only when every one of its children does.
            // Otherwise it records why, so whatever needed it can say so.
            for (((call, mut trace), slot), denied) in stage.iter().zip(traces).zip(slots).zip(denied) {
                let outcome = if trace.get("error").is_some() {
                    Err(expressions::BLOCKED)
                } else {
                    let failed: Vec<usize> = (0..slot.len()).filter(|i| slot[*i].is_none()).collect();
                    let mut texts = slot.into_iter().flatten();
                    let result = match call.for_each {
                        None => texts.next().map(Value::String).unwrap_or_default(),
                        Some(_) => Value::Array(texts.map(Value::String).collect()),
                    };
                    let size = result.to_string().len();
                    let outcome = if !failed.is_empty() {
                        if call.for_each.is_some() {
                            trace["failed"] = json!(failed.iter().take(16).collect::<Vec<_>>());
                            if !denied.is_empty() {
                                trace["refused"] = json!(denied.iter().take(16).collect::<Vec<_>>());
                            }
                        }
                        if failed.iter().all(|i| denied.contains(i)) {
                            Err(expressions::REFUSED)
                        } else {
                            Err(expressions::FAILED)
                        }
                    } else if raw_bytes + size > RETAINED_MAX {
                        Err(expressions::TOO_LARGE)
                    } else {
                        raw_bytes += size;
                        trace["bytes"] = json!(size);
                        Ok(result)
                    };
                    trace["status"] = json!(match outcome {
                        Ok(_) => "ok",
                        Err(expressions::REFUSED) => "refused",
                        Err(_) => "error",
                    });
                    outcome
                };
                results.insert(call.id.to_owned(), outcome);
                steps.push(trace);
            }
        }
        // Parts of the output that could not be worked out: where, and why.
        let mut lost = Vec::new();
        let output = expressions::resolve_output(plan.output, &results, &mut lost).and_then(|v| {
            if v.to_string().len() <= expressions::OUTPUT_MAX {
                Ok(v)
            } else {
                Err("the output is over 16KiB; filter it further".into())
            }
        });
        let failed = output.is_err() || !lost.is_empty() || steps.iter().any(|s| s["status"] != "ok");
        let mut report = json!({
            "status":if failed {"partial"} else {"ok"},
            "output":output.as_ref().ok(), "steps":steps,
            "retention":"batch-only", "execution":"parallel-reads", "runtime":"native",
            "hostPeakInFlight":peak,
            "metrics":{"rawBytes":raw_bytes,"elapsedMs":millis(started),"returnedBytes":0}
        });
        // Why, by filter and kind of value: never a child's result or error.
        if let Err(why) = &output {
            report["outputError"] = json!(format!("Output unavailable: {why}."));
        }
        // The parts that are null because they could not be had, so a null
        // is never mistaken for a result. Fixed reasons, never child output.
        if output.is_ok() && !lost.is_empty() {
            report["unavailable"] = lost
                .iter()
                .take(UNAVAILABLE_MAX)
                .map(|(at, reason)| json!({"at":at,"reason":reason}))
                .collect();
            if lost.len() > UNAVAILABLE_MAX {
                report["unavailableMore"] = json!(lost.len() - UNAVAILABLE_MAX);
            }
        }
        report["metrics"]["outputBytes"] = json!(report["output"].to_string().len());
        count_returned(&mut report);
        if report.to_string().len() > REPORT_MAX {
            // Diagnostics can quote long keys from the plan. Drop those
            // details before dropping otherwise useful output. IDs, statuses
            // and unavailable locations still identify the affected parts.
            let mut omitted = false;
            for step in report["steps"].as_array_mut().expect("steps are an array") {
                if step.get("error").is_some() {
                    step["error"] = json!("Details omitted: report size limit exceeded.");
                    omitted = true;
                }
            }
            if let Some(parts) = report.get_mut("unavailable").and_then(Value::as_array_mut) {
                for part in parts {
                    // Ordinary refusal/failure reasons stay intact. Only
                    // oversized filter/path diagnostics need abbreviation.
                    if part["reason"].as_str().is_some_and(|why| why.len() > 256) {
                        part["reason"] = json!("Details omitted: report size limit exceeded.");
                        omitted = true;
                    }
                }
            }
            if omitted {
                report["diagnosticsOmitted"] = json!(true);
                count_returned(&mut report);
            }
        }
        if report.to_string().len() > REPORT_MAX {
            report["status"] = json!("partial");
            report["output"] = Value::Null;
            if let Some(report) = report.as_object_mut() {
                report.remove("unavailable");
                report.remove("unavailableMore");
            }
            report["metrics"]["outputBytes"] = json!(4);
            report["outputError"] =
                json!("Live report size limit exceeded; request a smaller output or batch.");
            count_returned(&mut report);
        }
        let mut done = Done::text(report.to_string());
        done.failed = report["status"] != "ok";
        Ok(done)
    }
}

fn millis(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 100_000.0).round() / 100.0
}

fn count_returned(report: &mut Value) {
    for _ in 0..4 {
        report["metrics"]["returnedBytes"] = json!(report.to_string().len());
    }
}

fn unnumber(text: &str) -> String {
    text.split_inclusive('\n')
        .map(|line| {
            let trimmed = line.trim_start_matches(' ');
            let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && trimmed.as_bytes().get(digits) == Some(&b'\t') {
                &trimmed[digits + 1..]
            } else {
                line
            }
        })
        .collect()
}
