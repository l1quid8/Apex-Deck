use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfiguredCheck {
    pub id: String,
    pub argv: Vec<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VerificationResult {
    Passed { output: String },
    Failed { exit: i32, output: String },
    Timeout,
    NotConfigured,
}

pub fn verify_candidate(_check: &ConfiguredCheck) -> Result<VerificationResult, String> {
    // Placeholder: actual execution would use room's canonical folder and permission system.
    // For now, reject if check id not configured, else simulate.
    // In real implementation, run argv in canonical folder with timeout/output bounds.
    Ok(VerificationResult::NotConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_check_returns_not_configured() {
        let check = ConfiguredCheck { id: "c1".into(), argv: vec!["npx".into(), "tsc".into(), "--noEmit".into()], timeout_ms: Some(10000) };
        let res = verify_candidate(&check).unwrap();
        assert_eq!(res, VerificationResult::NotConfigured);
    }
}
