use super::{manifest::Item, Progress, VoiceServer};
use async_trait::async_trait;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);
impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        loop {
            if self.0.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.0.load(Ordering::SeqCst) {
            Err("Voice setup canceled.".into())
        } else {
            Ok(())
        }
    }
}
#[async_trait]
pub trait Fetch: Send + Sync {
    async fn fetch(
        &self,
        url: &str,
        max_bytes: u64,
        to: &Path,
        progress: &(dyn Fn(u64) + Send + Sync),
        cancel: &Cancel,
    ) -> Result<(), String>;
}
#[async_trait]
pub trait Run: Send + Sync {
    async fn run(
        &self,
        program: &Path,
        args: &[OsString],
        env: &[(&str, String)],
        cancel: &Cancel,
    ) -> Result<(), String>;
}
pub struct Http;
#[async_trait]
impl Fetch for Http {
    async fn fetch(
        &self,
        url: &str,
        max_bytes: u64,
        to: &Path,
        progress: &(dyn Fn(u64) + Send + Sync),
        cancel: &Cancel,
    ) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(std::time::Duration::from_secs(120))
            .read_timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let response=tokio::select!{r=client.get(url).send()=>r.map_err(|e|e.to_string())?,_=cancel.cancelled()=>return Err("Voice setup canceled.".into())}.error_for_status().map_err(|e|e.to_string())?;
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(to)
            .await
            .map_err(|e| e.to_string())?;
        let mut n = 0;
        while let Some(chunk) = tokio::select! {chunk=stream.next()=>chunk,_=cancel.cancelled()=>return Err("Voice setup canceled.".into())}
        {
            cancel.check()?;
            let chunk = chunk.map_err(|e| e.to_string())?;
            n += chunk.len() as u64;
            if n > max_bytes {
                return Err("Voice download exceeds manifest size".into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            progress(n);
        }
        cancel.check()?;
        Ok(())
    }
}
pub struct Process;
#[async_trait]
impl Run for Process {
    async fn run(
        &self,
        program: &Path,
        args: &[OsString],
        env: &[(&str, String)],
        cancel: &Cancel,
    ) -> Result<(), String> {
        let mut c = tokio::process::Command::new(program);
        c.args(args)
            .envs(env.iter().map(|(k, v)| (*k, v)))
            .env("PYTHONNOUSERSITE", "1")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        let mut stderr = child.stderr.take().unwrap();
        // Drain continuously, retaining only a bounded tail.
        let drain = tokio::spawn(async move {
            let mut tail = Vec::new();
            let mut b = [0; 4096];
            while let Ok(n) = stderr.read(&mut b).await {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&b[..n]);
                if tail.len() > 2000 {
                    tail.drain(..tail.len() - 2000);
                }
            }
            tail
        });
        let result = loop {
            cancel.check()?;
            tokio::select! {s=child.wait()=>break s.map_err(|e|e.to_string())?,_=tokio::time::sleep(std::time::Duration::from_millis(100))=>{}}
        };
        let tail = drain.await.unwrap_or_default();
        if result.success() {
            Ok(())
        } else {
            Err(format!(
                "Voice setup command failed ({}): {}",
                result.code().unwrap_or(-1),
                String::from_utf8_lossy(&tail)
            ))
        }
    }
}
pub async fn verified(path: &Path, item: &Item) -> bool {
    let Ok(mut f) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    let mut size = 0;
    loop {
        let Ok(n) = f.read(&mut b).await else {
            return false;
        };
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > item.size {
            return false;
        }
        h.update(&b[..n]);
    }
    size == item.size && format!("{:x}", h.finalize()) == item.sha256
}
pub async fn install(server: &VoiceServer, cancel: &Cancel) -> Result<(), String> {
    let m = &server.manifest;
    let root = &server.root;
    let stage = root.join(format!("{}.staging", m.version));
    let dest = root.join(&m.version);
    let _ = tokio::fs::remove_dir_all(&stage).await;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| e.to_string())?;
    let free = (server.deps.free_bytes)(root)?;
    if free < m.required_disk_bytes {
        return Err(format!(
            "Not enough free disk space for voice: it needs {:.1} GB and {:.1} GB is free.",
            m.required_disk_bytes as f64 / 1e9,
            free as f64 / 1e9
        ));
    }
    let cache = root.join("downloads");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|e| e.to_string())?;
    let mut done = 0;
    for item in std::iter::once(&m.python)
        .chain(m.wheels.iter().map(|x| &x.item))
        .chain(m.models.iter().map(|x| &x.item))
    {
        cancel.check()?;
        let path = cache.join(&item.sha256);
        if !verified(&path, item).await {
            let partial = path.with_extension("partial");
            let progress = |n| {
                server.progress(Progress {
                    stage: "Downloading".into(),
                    downloaded: done + n,
                    total: m.download_bytes,
                })
            };
            server
                .deps
                .fetch
                .fetch(&item.url, item.size, &partial, &progress, cancel)
                .await?;
            cancel.check()?;
            if !verified(&partial, item).await {
                return Err("Voice download hash or size mismatch".into());
            }
            tokio::fs::rename(partial, &path)
                .await
                .map_err(|e| e.to_string())?;
        }
        done += item.size;
    }
    tokio::fs::create_dir_all(&stage)
        .await
        .map_err(|e| e.to_string())?;
    let set = |name: &str| {
        server.progress(Progress {
            stage: name.into(),
            downloaded: done,
            total: m.download_bytes,
        })
    };
    set("Unpacking Python");
    server
        .deps
        .run
        .run(
            Path::new("/usr/bin/tar"),
            &[
                "-xzf".into(),
                cache.join(&m.python.sha256).into_os_string(),
                "-C".into(),
                stage.clone().into_os_string(),
            ],
            &[],
            cancel,
        )
        .await?;
    let python = stage.join("python/bin/python3");
    let wheels = stage.join("wheels");
    tokio::fs::create_dir_all(&wheels)
        .await
        .map_err(|e| e.to_string())?;
    let mut args: Vec<OsString> = [
        "-I",
        "-m",
        "pip",
        "install",
        "--no-index",
        "--no-deps",
        "--disable-pip-version-check",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    for w in &m.wheels {
        cancel.check()?;
        let to = wheels.join(&w.filename);
        tokio::fs::copy(cache.join(&w.item.sha256), &to)
            .await
            .map_err(|e| e.to_string())?;
        args.push(to.into_os_string());
    }
    set("Installing speech engines");
    server
        .deps
        .run
        .run(&python, &args, &[("PIP_NO_INDEX", "1".into())], cancel)
        .await?;
    for model in &m.models {
        cancel.check()?;
        let to = stage.join(&model.path);
        tokio::fs::create_dir_all(to.parent().unwrap())
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::copy(cache.join(&model.item.sha256), to)
            .await
            .map_err(|e| e.to_string())?;
    }
    set("Checking");
    server.deps.run.run(&python,&["-I".into(),"-c".into(),"import ctranslate2, faster_whisper, kokoro_onnx, onnxruntime, websockets; from transformers import WhisperFeatureExtractor; import importlib.util; assert importlib.util.find_spec(\"silero_vad\"); print(\"ok\")".into()],&[],cancel).await?;
    cancel.check()?;
    tokio::fs::write(
        stage.join("complete.json"),
        serde_json::json!({"version":m.version,"manifestSha256":server.manifest_hash}).to_string(),
    )
    .await
    .map_err(|e| e.to_string())?;
    if dest.exists() {
        return Err("Voice runtime version already exists".into());
    }
    tokio::fs::rename(&stage, &dest)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_dir_all(cache).await;
    Ok(())
}
