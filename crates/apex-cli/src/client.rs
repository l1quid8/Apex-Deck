//! One bounded, concurrent protocol session. No mutations are retried here.
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub boot_id: String,
    pub seq: u64,
}
pub type ClientError = String;
type Reply = oneshot::Sender<Result<Value, ClientError>>;
struct Request {
    id: u64,
    frame: Value,
    reply: Reply,
}
struct Inner {
    output: mpsc::Sender<Request>,
    next: AtomicU64,
    task: tokio::task::AbortHandle,
    max_frame: usize,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone)]
pub struct Client(Arc<Inner>);

impl Client {
    pub async fn connect(
        data: &Path,
        since: Option<Cursor>,
    ) -> Result<(Self, mpsc::Receiver<Value>, Value), ClientError> {
        let endpoint = apex_daemon::ipc::endpoint(data).map_err(|e| e.to_string())?;
        let stream = tokio::time::timeout(
            Duration::from_secs(10),
            apex_daemon::ipc::connect(&endpoint),
        )
        .await
        .map_err(|_| "Daemon connection timed out".to_string())?
        .map_err(|e| {
            format!(
                "Cannot connect to backend {}: {e}.",
                endpoint.display()
            )
        })?;
        let (r, w) = apex_daemon::ipc::split(stream);
        let (mut input, mut output) = apex_daemon::protocol::lines(r, w);
        output
            .send(json!({"id":0,"cmd":"hello","args":{"protocol":1,"since":since}}).to_string())
            .await
            .map_err(|e| e.to_string())?;
        let line = tokio::time::timeout(Duration::from_secs(10), input.next())
            .await
            .map_err(|_| "Daemon hello timed out")?
            .ok_or("Daemon closed before hello")?
            .map_err(|e| e.to_string())?;
        let frame: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let hello = frame
            .get("ok")
            .filter(|v| {
                frame["id"] == 0
                    && frame.get("err").is_none()
                    && v["protocol"] == 1
                    && v["boot_id"].as_str().is_some_and(|s| !s.is_empty())
                    && v["host_id"].as_str().is_some_and(|s| !s.is_empty())
                    && v["last_seq"].is_u64()
                    && v["resumed"].is_boolean()
                    && v["capabilities"]
                        .as_array()
                        .is_some_and(|a| a.iter().all(Value::is_string))
                    && v["max_frame_bytes"]
                        .as_u64()
                        .is_some_and(|n| n > 0 && n <= apex_daemon::protocol::MAX_FRAME as u64)
            })
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Daemon refused protocol 1 or sent an invalid hello: {}",
                    frame.get("err").unwrap_or(&frame)
                )
            })?;
        let max_frame = hello["max_frame_bytes"].as_u64().unwrap() as usize;
        let (tx, mut requests) = mpsc::channel::<Request>(128);
        let (events, rx) = mpsc::channel(2048);
        let task = tokio::spawn(async move {
            let mut pending: HashMap<u64, Reply> = HashMap::new();
            let failure = loop {
                tokio::select! {
                    _=events.closed()=>break "Client closed".to_string(),
                    request=requests.recv()=> {
                        let Some(request)=request else {break "Client closed".to_string()};
                        if pending.len()>=128 {let _=request.reply.send(Err("Too many pending requests".into()));continue;}
                        pending.insert(request.id,request.reply);
                        if let Err(e)=output.send(request.frame.to_string()).await {break e.to_string();}
                    },
                    line=input.next()=> {
                        let line=match line {Some(Ok(v))=>v,Some(Err(e))=>break e.to_string(),None=>break "Daemon disconnected; outcome unknown; refresh before retrying".to_string()};
                        if line.len()>max_frame { break "Daemon response exceeds negotiated frame limit".into(); }
                        let frame:Value=match serde_json::from_str(&line) {Ok(v)=>v,Err(e)=>break format!("Malformed daemon frame: {e}")};
                        if let Some(id)=frame["id"].as_u64() {
                            let Some(reply)=pending.remove(&id) else {break "Unexpected daemon reply ID".into()};
                            let result=if let Some(err)=frame.get("err") {Err(err.as_str().unwrap_or("Daemon refused").to_string())}
                                else if let Some(ok)=frame.get("ok") {Ok(ok.clone())} else {Err("Malformed daemon reply".into())};
                            let _=reply.send(result);
                        } else if frame["seq"].is_u64() && frame["event"].is_string() {
                            // A slow renderer reconnects and snapshots rather than silently losing events.
                            if events.try_send(frame).is_err(){break "Event buffer overflow; reload required".into();}
                        } else {break "Malformed daemon event".into();}
                    }
                }
            };
            for (_, reply) in pending {
                let _ = reply.send(Err(failure.clone()));
            }
            while let Ok(request) = requests.try_recv() {
                let _ = request.reply.send(Err(failure.clone()));
            }
        });
        Ok((
            Self(Arc::new(Inner {
                output: tx,
                next: AtomicU64::new(1),
                task: task.abort_handle(),
                max_frame,
            })),
            rx,
            hello,
        ))
    }
    pub async fn request(&self, cmd: &str, args: Value) -> Result<Value, ClientError> {
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let frame = json!({"id":id,"cmd":cmd,"args":args});
        if frame.to_string().len() > self.0.max_frame {
            return Err("Request exceeds daemon frame limit".into());
        }
        let (reply, rx) = oneshot::channel();
        self.0
            .output
            .send(Request { id, frame, reply })
            .await
            .map_err(|_| "Daemon disconnected; refresh before retrying")?;
        rx.await.map_err(|_| {
            "Daemon disconnected; outcome unknown; refresh before retrying".to_string()
        })?
    }
}
