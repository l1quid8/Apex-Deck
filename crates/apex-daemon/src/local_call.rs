//! Talking to the running daemon over its local socket, for the CLIs
//! (`devices`, `remote`, `pair`).

use std::io::{BufRead, BufReader, Write};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::protocol;

/// Say hello on the daemon's socket, send `request`, and return its answer.
pub fn through_daemon(socket: std::os::unix::net::UnixStream, mut request: Value) -> Result<Value, String> {
    request["id"] = json!(1);
    let mut writer = socket.try_clone().map_err(|e| e.to_string())?;
    let hello = json!({ "id": 0, "cmd": "hello", "args": { "protocol": protocol::PROTOCOL } });
    writeln!(writer, "{hello}\n{request}").map_err(|e| format!("could not reach the daemon: {e}"))?;
    for line in BufReader::new(socket).lines() {
        let frame: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if frame["id"] == json!(0) && frame.get("err").is_some() {
            return Err(frame["err"].as_str().unwrap_or("the daemon refused").to_string());
        }
        if frame["id"] == json!(1) {
            return match frame.get("err") {
                Some(why) => Err(why.as_str().unwrap_or_default().to_string()),
                None => Ok(frame["ok"].clone()),
            };
        }
    }
    Err("the daemon closed the connection without answering".into())
}

/// An `err` answer: the text to show, and the daemon's `reason` word when
/// it gave one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub err: String,
    pub reason: Option<String>,
}

impl From<String> for Refused {
    fn from(err: String) -> Refused {
        Refused { err, reason: None }
    }
}

/// A session on the local socket that may keep several requests going, as
/// `pair` does (a long `pair_wait`, then a `pair_cancel` beside it). Events
/// the daemon sends are skipped.
pub struct Client {
    input: FramedRead<OwnedReadHalf, LinesCodec>,
    output: FramedWrite<OwnedWriteHalf, LinesCodec>,
    next_id: u64,
}

impl Client {
    /// Say hello on `stream`.
    pub async fn hello(stream: UnixStream) -> Result<Client, Refused> {
        let (read, write) = stream.into_split();
        let (input, output) = protocol::lines(read, write);
        let mut client = Client { input, output, next_id: 0 };
        let id = client.send("hello", json!({ "protocol": protocol::PROTOCOL })).await?;
        client.reply(id).await?;
        Ok(client)
    }

    /// Send a request; its id, to wait on with `reply`.
    pub async fn send(&mut self, cmd: &str, args: Value) -> Result<u64, Refused> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({ "id": id, "cmd": cmd, "args": args });
        self.output.send(frame.to_string()).await.map_err(|e| format!("could not reach the daemon: {e}"))?;
        Ok(id)
    }

    /// The answer to request `id`. Frames for anything else are dropped.
    /// Safe to drop part way and call again.
    pub async fn reply(&mut self, id: u64) -> Result<Value, Refused> {
        while let Some(line) = self.input.next().await {
            let frame: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if frame["id"] != json!(id) {
                continue;
            }
            return match frame.get("err") {
                Some(why) => Err(Refused { err: why.as_str().unwrap_or("the daemon refused").to_string(), reason: frame["reason"].as_str().map(String::from) }),
                None => Ok(frame["ok"].clone()),
            };
        }
        Err("the daemon closed the connection without answering".to_string().into())
    }

    /// `send`, then `reply`.
    pub async fn call(&mut self, cmd: &str, args: Value) -> Result<Value, Refused> {
        let id = self.send(cmd, args).await?;
        self.reply(id).await
    }
}
