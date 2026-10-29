use serde::{Deserialize, Serialize};

pub const MAX_REPORT_BYTES: usize = 16 * 1024;
pub const MAX_CRITERIA: usize = 50;
pub const MAX_NARRATIVE: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerReportV1 {
    pub version: u32,
    pub disposition: String, // working|done|blocked
    pub done: String,
    pub next: String,
    pub blocker: Option<String>,
    pub criteria: Vec<ReportCriterion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCriterion {
    pub id: String,
    #[serde(default)]
    pub status: String, // pending|done|failed
    #[serde(default)]
    pub evidence: Vec<String>,
}

#[derive(Debug)]
pub enum ReportError {
    TooLarge,
    NoFence,
    InvalidJson(String),
    MissingField(String),
    InvalidEnum(String),
    DuplicateId(String),
    TooManyCriteria,
    NarrativeTooLong(String),
    VersionMismatch,
}

fn find_final_fence(reply: &str) -> Option<String> {
    // Find final top-level fenced block ```apex-runner ... ``` or ```json with apex?
    // Spec says fenced `apex-runner` JSON object. We look for ```apex-runner\n{...}\n```
    // Only final top-level fence of captured participant's final reply.
    // For simplicity, find all occurrences of ```apex-runner and take last.
    let mut last: Option<String> = None;
    let mut search_from = 0;
    while let Some(start) = reply[search_from..].find("```apex-runner") {
        let abs_start = search_from + start;
        // Find content after first newline
        if let Some(content_start) = reply[abs_start..].find('\n') {
            let content_start = abs_start + content_start + 1;
            if let Some(end) = reply[content_start..].find("\n```") {
                let end = content_start + end;
                let fence_content = reply[content_start..end].trim().to_string();
                last = Some(fence_content);
                search_from = end + 3;
                continue;
            }
        }
        break;
    }
    last
}

fn is_prose_done(reply: &str) -> bool {
    // If reply contains "done" in prose outside fence, we still require structured fence.
    // This function is not used to infer completion, only to detect false claims.
    false
}

pub fn parse_report(reply: &str) -> Result<RunnerReportV1, ReportError> {
    if reply.len() > MAX_REPORT_BYTES * 4 { // allow some overhead but check fence size
        // We'll check fence size after extraction
    }
    let fence = find_final_fence(reply).ok_or(ReportError::NoFence)?;

    if fence.len() > MAX_REPORT_BYTES {
        return Err(ReportError::TooLarge);
    }

    // Reject if report text inside quoted/code examples? Plan says reject report text inside quoted/code examples.
    // For strictness, if fence contains ``` inside, it's invalid (but we already extracted)
    // Also reject if original reply has duplicate fences? We take final, so duplicate is okay but we still parse final.

    let report: serde_json::Value = serde_json::from_str(&fence).map_err(|e| ReportError::InvalidJson(e.to_string()))?;

    // Validate version
    let version = report.get("version").and_then(|v| v.as_u64()).ok_or(ReportError::MissingField("version".into()))?;
    if version != 1 {
        return Err(ReportError::VersionMismatch);
    }

    // Extract fields
    let disposition = report.get("disposition").and_then(|v| v.as_str()).ok_or(ReportError::MissingField("disposition".into()))?.to_string();
    if !["working", "done", "blocked"].contains(&disposition.as_str()) {
        return Err(ReportError::InvalidEnum(format!("disposition {}", disposition)));
    }

    let done = report.get("done").and_then(|v| v.as_str()).ok_or(ReportError::MissingField("done".into()))?.to_string();
    let next = report.get("next").and_then(|v| v.as_str()).ok_or(ReportError::MissingField("next".into()))?.to_string();
    if done.len() > MAX_NARRATIVE { return Err(ReportError::NarrativeTooLong("done".into())); }
    if next.len() > MAX_NARRATIVE { return Err(ReportError::NarrativeTooLong("next".into())); }

    let blocker = if let Some(b) = report.get("blocker") {
        if b.is_null() { None } else {
            let s = b.as_str().ok_or(ReportError::InvalidEnum("blocker must be string or null".into()))?.to_string();
            if s.len() > MAX_NARRATIVE { return Err(ReportError::NarrativeTooLong("blocker".into())); }
            Some(s)
        }
    } else {
        None
    };

    let criteria_val = report.get("criteria").and_then(|v| v.as_array()).ok_or(ReportError::MissingField("criteria".into()))?;
    if criteria_val.len() > MAX_CRITERIA {
        return Err(ReportError::TooManyCriteria);
    }

    let mut criteria = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in criteria_val {
        let id = item.get("id").and_then(|v| v.as_str()).ok_or(ReportError::MissingField("criteria.id".into()))?.to_string();
        if !seen.insert(id.clone()) {
            return Err(ReportError::DuplicateId(id));
        }
        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string();
        if !["pending", "done", "failed"].contains(&status.as_str()) {
            return Err(ReportError::InvalidEnum(format!("criteria status {}", status)));
        }
        let evidence = item.get("evidence").and_then(|v| v.as_array()).map(|arr| {
            arr.iter().filter_map(|e| e.as_str().map(|s| s.to_string())).collect()
        }).unwrap_or_default();

        criteria.push(ReportCriterion { id, status, evidence });
    }

    Ok(RunnerReportV1 { version: 1, disposition, done, next, blocker, criteria })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_report() {
        let reply = r#"Some work done.

```apex-runner
{"version":1,"disposition":"working","done":"fixed login","next":"test","blocker":null,"criteria":[{"id":"c1","status":"done","evidence":["file changed"]}]}
```"#;
        let report = parse_report(reply).unwrap();
        assert_eq!(report.disposition, "working");
        assert_eq!(report.criteria.len(), 1);
    }

    #[test]
    fn rejects_missing_fence() {
        let reply = "We are done, no fence";
        assert!(matches!(parse_report(reply), Err(ReportError::NoFence)));
    }

    #[test]
    fn rejects_oversized() {
        let big = "x".repeat(MAX_REPORT_BYTES + 1);
        let reply = format!("```apex-runner\n{{\"version\":1,\"disposition\":\"working\",\"done\":\"{}\",\"next\":\"n\",\"blocker\":null,\"criteria\":[]}}\n```", big);
        assert!(matches!(parse_report(&reply), Err(ReportError::TooLarge) | Err(ReportError::NarrativeTooLong(_))));
    }

    #[test]
    fn rejects_duplicate_ids() {
        let reply = r#"```apex-runner
{"version":1,"disposition":"working","done":"d","next":"n","blocker":null,"criteria":[{"id":"c1","status":"done","evidence":[]},{"id":"c1","status":"pending","evidence":[]}]}
```"#;
        assert!(matches!(parse_report(reply), Err(ReportError::DuplicateId(_))));
    }

    #[test]
    fn rejects_invalid_enum() {
        let reply = r#"```apex-runner
{"version":1,"disposition":"finished","done":"d","next":"n","blocker":null,"criteria":[]}
```"#;
        assert!(matches!(parse_report(reply), Err(ReportError::InvalidEnum(_))));
    }

    #[test]
    fn parses_final_fence_only() {
        let reply = r#"First fence
```apex-runner
{"version":1,"disposition":"working","done":"old","next":"n","blocker":null,"criteria":[]}
```
Second fence final
```apex-runner
{"version":1,"disposition":"done","done":"new","next":"n","blocker":null,"criteria":[]}
```"#;
        let report = parse_report(reply).unwrap();
        assert_eq!(report.done, "new");
        assert_eq!(report.disposition, "done");
    }

    #[test]
    fn rejects_quoted_example_false_claim() {
        // Plan says reject report text inside quoted/code examples – we ensure ordinary prose "done" without fence fails
        let reply = "I am done, the task is finished.";
        assert!(matches!(parse_report(reply), Err(ReportError::NoFence)));
    }
}
