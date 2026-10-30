use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
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

impl ConfiguredCheck {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.argv.is_empty() || self.argv[0].trim().is_empty() || self.argv.iter().any(|a| a.contains('\0')) { return Err("check requires ID and argv".into()); }
        if self.timeout_ms.is_some_and(|t| t == 0 || t > 120_000) { return Err("check timeout must be 1..120000ms".into()); }
        Ok(())
    }
}

/// Execute only checks from protected start configuration, after the host has
/// applied the worker's current room permission. No shell interpolation.
pub fn prepare_check(check: &ConfiguredCheck, cwd: &std::path::Path, process_dir: &std::path::Path) -> Result<PreparedCheck,String> {
    use tokio::io::AsyncReadExt;
    check.validate()?;
    let cwd = cwd.canonicalize().map_err(|e|e.to_string())?;
    let mut cmd = tokio::process::Command::new(&check.argv[0]);
    cmd.args(&check.argv[1..]).current_dir(cwd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    std::fs::create_dir_all(process_dir).map_err(|e|e.to_string())?;
    let process_dir=process_dir.canonicalize().map_err(|e|e.to_string())?;
    let registry = apex_adapters::OwnedProcessRegistry::new(Some(process_dir));
    let mut child = registry.spawn(&mut cmd).map_err(|e|e.to_string())?;
    async fn drain(mut input: impl tokio::io::AsyncRead+Unpin) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new(); let mut buf=[0u8;4096];
        loop { let n=input.read(&mut buf).await?; if n==0 {break;} let keep=n.min(8192usize.saturating_sub(out.len()));out.extend_from_slice(&buf[..keep]); } Ok(out)
    }
    let stdout = tokio::spawn(drain(child.stdout.take().ok_or("check stdout missing")?));
    let stderr = tokio::spawn(drain(child.stderr.take().ok_or("check stderr missing")?));
    Ok(PreparedCheck {child,stdout,stderr,timeout_ms:check.timeout_ms.unwrap_or(30000)})
}

pub struct PreparedCheck {
    child: apex_adapters::OwnedProcessChild,
    stdout: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    timeout_ms:u64,
}
impl PreparedCheck {
    pub async fn finish(self,cancelled:impl std::future::Future<Output=()>)->Result<VerificationResult,String>{
        let Self{mut child,stdout,stderr,timeout_ms}=self;
    let status=tokio::select! {
        status=child.wait()=>Some(status.map_err(|e|e.to_string())?),
        _=tokio::time::sleep(std::time::Duration::from_millis(timeout_ms))=>None,
        _=cancelled=>None,
    };
    child.terminate_tree().await?;
    let output=tokio::time::timeout(std::time::Duration::from_secs(2),async {
        let out=stdout.await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
        let err=stderr.await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
        Ok::<_,String>(format!("{}{}",String::from_utf8_lossy(&out),String::from_utf8_lossy(&err)).chars().take(8192).collect::<String>())
    }).await.map_err(|_|"check output did not settle".to_string())??;
    match status {None=>Ok(VerificationResult::Timeout),Some(s) if s.success()=>Ok(VerificationResult::Passed{output}),Some(s)=>Ok(VerificationResult::Failed{exit:s.code().unwrap_or(-1),output})}
}
}

pub async fn run_check(check:&ConfiguredCheck,cwd:&std::path::Path,process_dir:&std::path::Path,cancelled:impl std::future::Future<Output=()>)->Result<VerificationResult,String>{
    prepare_check(check,cwd,process_dir)?.finish(cancelled).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reuse this native test executable so the real process checks need no shell
    // or platform-specific utilities. --exact keeps the child out of this test.
    fn fixture_argv(name: &str) -> Vec<String> {
        vec![
            std::env::current_exe().unwrap().to_str().unwrap().into(),
            "--ignored".into(), "--exact".into(), "--nocapture".into(),
            format!("runner::checks::tests::{name}"),
        ]
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn check_pass_fixture() {
        use std::io::Write;
        std::io::stdout().write_all(b"result").unwrap();
        std::io::stdout().flush().unwrap();
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn check_fail_fixture() {
        std::process::exit(7);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn check_output_fixture() {
        use std::io::Write;
        std::io::stdout().write_all(&vec![b'x'; 100_000]).unwrap();
        std::io::stderr().write_all(&vec![b'y'; 100_000]).unwrap();
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn check_timeout_fixture() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[tokio::test]
    async fn configured_argv_check_runs_and_bounds_output_and_timeout() {
        let root = std::env::temp_dir().join(format!("runner-check-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let processes=root.join("processes");
        let pass = ConfiguredCheck { id:"pass".into(),argv:fixture_argv("check_pass_fixture"),timeout_ms:Some(10_000) };
        assert!(matches!(run_check(&pass,&root,&processes,std::future::pending()).await.unwrap(), VerificationResult::Passed{output} if output.contains("result")));
        let fail = ConfiguredCheck { argv:fixture_argv("check_fail_fixture"),..pass.clone() };
        assert!(matches!(run_check(&fail,&root,&processes,std::future::pending()).await.unwrap(),VerificationResult::Failed{exit:7,..}));
        let long = ConfiguredCheck { argv:fixture_argv("check_output_fixture"),..pass.clone() };
        assert!(matches!(run_check(&long,&root,&processes,std::future::pending()).await.unwrap(),VerificationResult::Passed{output} if output.len() == 8192 && output.contains(&"x".repeat(100))));
        let timeout = ConfiguredCheck { argv:fixture_argv("check_timeout_fixture"),timeout_ms:Some(20),..pass };
        assert_eq!(run_check(&timeout,&root,&processes,std::future::pending()).await.unwrap(),VerificationResult::Timeout);
        std::fs::remove_dir_all(root).unwrap();
    }

}
