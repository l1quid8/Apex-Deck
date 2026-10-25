use async_trait::async_trait;
use futures::{future::BoxFuture, StreamExt};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Child,
};
pub const IDLE: Duration = Duration::from_secs(600);
pub const READY_WAIT: Duration = Duration::from_secs(90);
#[derive(Clone)]
pub struct Running {
    pub port: u16,
    pub token: String,
}
impl std::fmt::Debug for Running {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Running").field("port", &self.port).finish()
    }
}
#[async_trait]
pub trait Launch: Send + Sync {
    async fn launch(&self, version: &Path) -> Result<(Running, Box<dyn Helper>), String>;
}
pub trait Helper: Send {
    fn exited(&mut self) -> BoxFuture<'_, String>;
}
struct Process(Child);
impl Helper for Process {
    fn exited(&mut self) -> BoxFuture<'_, String> {
        Box::pin(async move {
            let _ = self.0.wait().await;
            "voice helper stopped".into()
        })
    }
}
/// Starts the embedded helper with the private runtime's Python: `cpu` on Linux servers, `mlx` on a Mac.
pub struct Python {
    pub engine: &'static str,
}
pub const CPU: Python = Python { engine: "cpu" };
pub const MLX: Python = Python { engine: "mlx" };
#[async_trait]
impl Launch for Python {
    async fn launch(&self, version: &Path) -> Result<(Running, Box<dyn Helper>), String> {
        self.launch_with_wait(version, READY_WAIT).await
    }
}
impl Python {
    async fn launch_with_wait(
        &self,
        version: &Path,
        ready_wait: Duration,
    ) -> Result<(Running, Box<dyn Helper>), String> {
        let mut hash = Sha256::new();
        for (name, text) in super::sources::FILES {
            hash.update(name);
            hash.update(text);
        }
        let app = version
            .join("app")
            .join(&format!("{:x}", hash.finalize())[..16]);
        let package = app.join("voice_sidecar");
        tokio::fs::create_dir_all(&package)
            .await
            .map_err(|e| e.to_string())?;
        for (name, text) in super::sources::FILES {
            let p = package.join(name);
            let tmp = p.with_extension("tmp");
            tokio::fs::write(&tmp, text)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::rename(tmp, p).await.map_err(|e| e.to_string())?;
        }
        let token = crate::identity::random_hex(32);
        let mut cmd = tokio::process::Command::new(version.join("python/bin/python3"));
        cmd.args(["-I","-c","import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module(\"voice_sidecar.server\",run_name=\"__main__\")"]).arg(&app).arg("--root").arg(version).args(["--engine",self.engine,"--token-fd","0","--origin","apex-daemon"])
 .env_clear().env("HOME",std::env::var_os("HOME").unwrap_or_default()).env("PATH","/usr/bin:/bin").env("HF_HUB_OFFLINE","1").env("TRANSFORMERS_OFFLINE","1").env("HF_HOME",version.join("cache")).env("PYTHONNOUSERSITE","1").env("TOKENIZERS_PARALLELISM","false").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    return Err(std::io::Error::other("parent exited"));
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stderr = child.stderr.take().unwrap();
        let log = version.parent().unwrap().join("calls.log");
        tokio::spawn(async move {
            use std::io::Write;
            let mut lines = tokio_util::codec::FramedRead::new(
                stderr,
                tokio_util::codec::LinesCodec::new_with_max_length(65536),
            );
            while let Some(Ok(line)) = lines.next().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if matches!(v["type"].as_str(), Some("sessionError" | "speechDropped")) {
                        let mut entry = serde_json::json!({"at":crate::log_time::utc_stamp(),"event":v["type"]});
                        if let Some(class) = v["class"].as_str().filter(|c| {
                            c.len() <= 64
                                && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                        }) {
                            entry["class"] = class.into();
                        }
                        if v["class"] == "ValueError" {
                            if let Some(message) = v["message"].as_str().filter(|m| {
                                matches!(
                                    *m,
                                    "Invalid capture sequence"
                                        | "Utterance too long; please pause"
                                        | "Speech processing overloaded"
                                        | "Call already started"
                                        | "Invalid call"
                                        | "Invalid voice"
                                        | "Invalid endpoint"
                                        | "Invalid hints"
                                        | "Invalid generation"
                                        | "Invalid speech segment"
                                        | "Invalid audio length"
                                        | "Invalid protocol"
                                        | "Control too large"
                                        | "Unknown control"
                                        | "Audio chunk exceeds playback window"
                                        | "Invalid playback credit"
                                        | "Generation must increase"
                                        | "Choose an installed voice"
                                        | "Expected a 512-sample VAD frame"
                                        | "Expected 24 kHz speech"
                                )
                            }) {
                                entry["message"] = message.into();
                            }
                        }
                        if let Some(fields) = v.as_object() {
                            for (k, value) in fields {
                                if value.is_number() {
                                    entry[k] = value.clone();
                                }
                            }
                        }
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&log)
                        {
                            let _ = writeln!(f, "{entry}");
                        }
                    }
                }
            }
        });
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(format!("{token}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);
        let stdout = child.stdout.take().unwrap();
        let ready = async {
            let mut reader = BufReader::new(stdout.take(65537));
            let mut consumed = 0;
            loop {
                let mut line = Vec::new();
                let n = tokio::io::AsyncBufReadExt::read_until(&mut reader, b'\n', &mut line)
                    .await
                    .map_err(|e| e.to_string())?;
                consumed += n;
                if n == 0 || consumed > 65536 {
                    return Err::<u16, String>("voice helper stopped before ready".into());
                }
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) {
                    if v["type"] == "ready" && v["protocolVersion"] == 1 {
                        if let Some(p) = v["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                            return Ok(p as u16);
                        }
                    }
                }
            }
        };
        let port = tokio::time::timeout(ready_wait, ready)
            .await
            .map_err(|_| "Voice took too long to start on this machine.".to_string())??;
        Ok((Running { port, token }, Box::new(Process(child))))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_python_module_is_embedded() {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../voice-sidecar/voice_sidecar");
        for file in std::fs::read_dir(source).unwrap() {
            let p = file.unwrap().path();
            if p.extension().and_then(|s| s.to_str()) == Some("py") {
                let name = p.file_name().unwrap().to_str().unwrap();
                let embedded = super::super::sources::FILES
                    .iter()
                    .find(|(n, _)| *n == name)
                    .unwrap();
                assert_eq!(std::fs::read_to_string(p).unwrap(), embedded.1);
            }
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn token_is_on_stdin_and_sources_are_written() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("voice-launch-{}", crate::identity::random_hex(8)));
        std::fs::create_dir_all(root.join("python/bin")).unwrap();
        let python = root.join("python/bin/python3");
        let script=format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nread token\nprintf '%s' \"$token\" > '{}'\nprintf '%s\\n' '{{\"type\":\"ready\",\"port\":4321,\"protocolVersion\":1}}'\nexec sleep 30\n",root.join("argv").display(),root.join("token").display());
        std::fs::write(&python, script).unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (running, helper) = CPU.launch(&root).await.unwrap();
        assert_eq!(running.port, 4321);
        assert_eq!(
            std::fs::read_to_string(root.join("token")).unwrap(),
            running.token
        );
        let argv = std::fs::read_to_string(root.join("argv")).unwrap();
        assert!(!argv.contains(&running.token));
        for arg in ["--engine\ncpu", "--token-fd\n0", "--origin\napex-daemon"] {
            assert!(argv.contains(arg));
        }
        let app = std::fs::read_dir(root.join("app"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let server = super::super::sources::FILES
            .iter()
            .find(|(n, _)| *n == "server.py")
            .unwrap()
            .1;
        assert_eq!(
            std::fs::read_to_string(app.join("voice_sidecar/server.py")).unwrap(),
            server
        );
        drop(helper);
        let (_, helper) = MLX.launch(&root).await.unwrap();
        assert!(std::fs::read_to_string(root.join("argv"))
            .unwrap()
            .contains("--engine\nmlx"));
        drop(helper);
        let _ = std::fs::remove_dir_all(root);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_timeout_kills_the_helper() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("voice-timeout-{}", crate::identity::random_hex(8)));
        std::fs::create_dir_all(root.join("python/bin")).unwrap();
        let python = root.join("python/bin/python3");
        std::fs::write(
            &python,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
                root.join("pid").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Allow the fixture process to start and record its PID before the
        // readiness deadline, even when executable startup is slow on CI.
        let result = CPU
            .launch_with_wait(&root, Duration::from_secs(2))
            .await;
        assert_eq!(
            result.err().unwrap(),
            "Voice took too long to start on this machine."
        );
        let pid = std::fs::read_to_string(root.join("pid"))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
