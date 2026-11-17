//! Turn-local MCP transport for the existing, permission-checked batch engine.
use crate::api_tools::{ToolCall, Turn};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const RELAY_ARG: &str = "--code-mode-mcp";
const ENDPOINT: &str = "APEX_CODE_MODE_ENDPOINT";
const TOKEN: &str = "APEX_CODE_MODE_TOKEN";
const MAX: u64 = 131_072;
pub(crate) const SERVER: &str = "apex-code-mode";
pub(crate) const HINT: &str = "\nApex Code Mode is available through the apex-code-mode MCP server's deck_code_mode tool. For multi-file reads, use a compact forEach batch and filter the output to keep raw file contents out of context. Each operation still follows Deck permissions; declined operations must not be retried. This is a bounded JSON plan, not JavaScript.\n";

#[derive(Default)]
pub(crate) struct Cancellation {
    stopped: AtomicBool,
    wake: tokio::sync::Notify,
}
impl Cancellation {
    pub fn reset(&self) {
        self.stopped.store(false, Ordering::SeqCst);
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
    async fn cancelled(&self) {
        let wake = self.wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        if !self.stopped.load(Ordering::SeqCst) {
            wake.await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct Launch {
    address: String,
    token: String,
}
pub(crate) struct Bridge {
    listener: tokio::net::TcpListener,
    pub launch: Launch,
    id_prefix: String,
}
impl Bridge {
    pub async fn bind() -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let address = listener.local_addr()?.to_string();
        let id_prefix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos()
            .to_string();
        Ok(Self {
            listener,
            launch: Launch { address, token },
            id_prefix,
        })
    }

    pub async fn serve(&self, turn: &mut Turn<'_>, cancel: &Cancellation) -> std::io::Result<()> {
        let operation = async {
            let mut serial = 0u64;
            loop {
                let (socket, _) = self.listener.accept().await?;
                let (read, mut write) = socket.into_split();
                let mut read = BufReader::new(read);
                let auth =
                    tokio::time::timeout(std::time::Duration::from_secs(5), line(&mut read)).await;
                if !matches!(auth, Ok(Ok(ref value)) if value.as_deref() == Some(&self.launch.token))
                {
                    continue;
                }
                let (send, mut receive) = tokio::sync::mpsc::channel(8);
                let reader = async {
                    while let Some(input) = line(&mut read).await? {
                        let request: Value =
                            serde_json::from_str(&input).map_err(std::io::Error::other)?;
                        // A cancellation notification terminates this connection's
                        // pending batch. Already completed writes are not undone.
                        if request["method"] == "notifications/cancelled" {
                            break;
                        }
                        if send.send(request).await.is_err() {
                            break;
                        }
                    }
                    Ok::<_, std::io::Error>(())
                };
                let executor = async {
                    while let Some(request) = receive.recv().await {
                        serial += 1;
                        if let Some(response) =
                            dispatch(turn, request, &self.id_prefix, serial).await
                        {
                            write.write_all(response.to_string().as_bytes()).await?;
                            write.write_all(b"\n").await?;
                        }
                    }
                    Ok::<_, std::io::Error>(())
                };
                // EOF (including killed relay) drops a pending approval and all
                // later stages. Protocol errors close this session, not the turn.
                tokio::select! { biased; _ = reader => {}, _ = executor => {} }
            }
        };
        tokio::select! { biased; _ = cancel.cancelled() => Ok(()), result = operation => result }
    }
}

async fn line<R: tokio::io::AsyncBufRead + Unpin>(read: &mut R) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let size = read.take(MAX + 1).read_until(b'\n', &mut bytes).await?;
    if size == 0 {
        return Ok(None);
    }
    if size as u64 > MAX || bytes.last() != Some(&b'\n') {
        return Err(std::io::Error::other("MCP frame too large or incomplete"));
    }
    bytes.pop();
    String::from_utf8(bytes)
        .map(Some)
        .map_err(std::io::Error::other)
}

async fn dispatch(turn: &mut Turn<'_>, request: Value, prefix: &str, serial: u64) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request["method"].as_str() {
        Some("initialize") => {
            json!({"protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"), "capabilities":{"tools":{}},"serverInfo":{"name":"apex-code-mode","version":env!("CARGO_PKG_VERSION")}})
        }
        Some("ping") => json!({}),
        Some("tools/list") => {
            let definition = turn
                .definitions()
                .into_iter()
                .find(|d| d["function"]["name"] == "deck_code_mode");
            let tools: Vec<Value> = definition.into_iter().map(|d| {
                let f = &d["function"];
                json!({"name":f["name"],"description":f["description"],"inputSchema":f["parameters"]})
            }).collect();
            json!({"tools":tools})
        }
        Some("tools/call") if request["params"]["name"] == "deck_code_mode" => {
            let call = ToolCall {
                id: format!("cli-batch-{prefix}-{serial}"),
                name: "deck_code_mode".into(),
                arguments: request["params"]["arguments"].to_string(),
                ..Default::default()
            };
            let reply = turn.run(&call).await;
            json!({"content":[{"type":"text","text":reply.text}]})
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Only deck_code_mode is available"}}),
            )
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

impl Launch {
    pub fn env(&self) -> [(String, String); 2] {
        [
            (ENDPOINT.into(), self.address.clone()),
            (TOKEN.into(), self.token.clone()),
        ]
    }
    pub fn claude_config(&self, helper: &Path) -> Value {
        json!({"mcpServers":{SERVER:{"type":"stdio","command":helper,"args":[RELAY_ARG]}}})
    }
    /// Sent on Claude's private control stream before submitting the current turn.
    /// A fresh relay process receives only this turn's bridge credentials.
    pub fn claude_dynamic_servers(&self, helper: &Path) -> Value {
        let env: std::collections::BTreeMap<_, _> = self.env().into_iter().collect();
        json!({SERVER:{"type":"stdio","command":helper,"args":[RELAY_ARG],"env":env}})
    }

    pub fn codex_flags(&self, helper: &Path) -> Vec<String> {
        vec![
            "-c".into(),
            format!(
                "mcp_servers.{SERVER}={{command={},args=[{}],enabled=true,env_vars={}}}",
                json!(helper),
                json!(RELAY_ARG),
                json!([ENDPOINT, TOKEN])
            ),
        ]
    }
}

/// Stdio is reserved for MCP frames. Credentials are inherited, never in argv.
pub fn relay_main() -> i32 {
    fn relay() -> std::io::Result<()> {
        use std::io::Write;
        let address: std::net::SocketAddr = std::env::var(ENDPOINT)
            .map_err(std::io::Error::other)?
            .parse()
            .map_err(std::io::Error::other)?;
        if !address.ip().is_loopback() {
            return Err(std::io::Error::other("Non-local MCP endpoint"));
        }
        let token = std::env::var(TOKEN).map_err(std::io::Error::other)?;
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(std::io::Error::other("Invalid MCP capability"));
        }
        let mut socket =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5))?;
        writeln!(socket, "{token}")?;
        let mut output = socket.try_clone()?;
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut socket);
            let _ = socket.shutdown(std::net::Shutdown::Both);
        });
        std::io::copy(&mut output, &mut std::io::stdout().lock())?;
        Ok(())
    }
    if relay().is_ok() {
        0
    } else {
        eprintln!("Apex Code Mode relay disconnected");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_tools::ToolBox;
    use apex_core::{Access, NoApprover};
    use serde_json::json;

    #[tokio::test]
    async fn global_off_updates_mcp_catalog_and_rejects_a_cached_tool_call() {
        let dir = std::env::temp_dir().join(format!("mcp-global-off-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tools = ToolBox::new(&crate::BuildContext { cwd: Some(dir.clone()), data_dir: Some(dir.clone()), ..Default::default() });
        let progress = |_: apex_core::Progress<'_>| {};
        let mut turn = Turn::new(&tools, Access::Full, false, Access::Full, &NoApprover, &progress);
        crate::set_code_mode_enabled(&dir, false);
        let list = dispatch(&mut turn, json!({"id":1,"method":"tools/list"}), "off", 1).await.unwrap();
        assert_eq!(list["result"]["tools"], json!([]));
        let reply = dispatch(&mut turn, json!({"id":2,"method":"tools/call","params":{"name":"deck_code_mode","arguments":{
            "stages":[[{"id":"w","tool":"write_file","args":{"path":"no.txt","content":"no"}}]],"output":null
        }}}), "off", 2).await.unwrap();
        assert!(reply["result"]["content"][0]["text"].as_str().unwrap().contains("Off"));
        assert!(!dir.join("no.txt").exists());
        crate::set_code_mode_enabled(&dir, true);
        let list = dispatch(&mut turn, json!({"id":3,"method":"tools/list"}), "on", 3).await.unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "deck_code_mode");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn mcp_batch_uses_deck_permissions_and_preserves_partial_results() {
        let dir = std::env::temp_dir().join(format!("deck-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("read.txt"), "RECORD {\"units\":9}\n").unwrap();
        let tools = ToolBox::new(&crate::BuildContext {
            cwd: Some(dir.clone()),
            ..Default::default()
        });
        let progress = |_: apex_core::Progress<'_>| {};
        let mut turn = Turn::new(
            &tools,
            Access::Read,
            false,
            Access::Read,
            &NoApprover,
            &progress,
        );
        let reply = dispatch(&mut turn, json!({"id":1,"method":"tools/call","params":{"name":"deck_code_mode","arguments":{
            "stages":[[{"id":"r","tool":"read_file","args":{"path":"read.txt"}}],[{"id":"w","tool":"write_file","args":{"path":"denied.txt","content":"no"}}]],
            "output":{"read":{"$ref":"r"},"write":{"$ref":"w"}}
        }}}), "test", 1).await.unwrap();
        let result: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(result["status"], "partial");
        assert!(result["output"]["read"].as_str().unwrap().contains("units"));
        assert!(result["output"]["write"].is_null());
        assert!(!dir.join("denied.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn mcp_catalog_exposes_only_batch_and_rejects_other_tools() {
        let tools = ToolBox::new(&crate::BuildContext::default());
        let progress = |_: apex_core::Progress<'_>| {};
        let mut turn = Turn::new(
            &tools,
            Access::Read,
            false,
            Access::Read,
            &NoApprover,
            &progress,
        );
        let catalog = dispatch(&mut turn, json!({"id":1,"method":"tools/list"}), "test", 1)
            .await
            .unwrap();
        assert_eq!(catalog["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["result"]["tools"][0]["name"], "deck_code_mode");
        let denied = dispatch(
            &mut turn,
            json!({"id":2,"method":"tools/call","params":{"name":"write_file","arguments":{}}}),
            "test",
            2,
        )
        .await
        .unwrap();
        assert_eq!(denied["error"]["code"], -32602);
    }

    struct PendingApproval(tokio::sync::Notify);

    struct FirstWriteOnly(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl apex_core::Approver for FirstWriteOnly {
        async fn decide(&self, _: apex_core::ProposedAction) -> apex_core::Decision {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                apex_core::Decision::Approve
            } else {
                apex_core::Decision::Reject
            }
        }
    }

    #[tokio::test]
    async fn mcp_ask_checks_each_write_in_order_and_keeps_approved_output() {
        let bridge = Bridge::bind().await.unwrap();
        let dir = std::env::temp_dir().join(format!(
            "deck-mcp-writes-{}",
            bridge.listener.local_addr().unwrap().port()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let tools = ToolBox::new(&crate::BuildContext {
            cwd: Some(dir.clone()),
            ..Default::default()
        });
        let approvals = FirstWriteOnly(Default::default());
        let progress = |_: apex_core::Progress<'_>| {};
        let mut turn = Turn::new(
            &tools,
            Access::Ask,
            false,
            Access::Ask,
            &approvals,
            &progress,
        );
        let reply = dispatch(&mut turn, json!({"id":1,"method":"tools/call","params":{"name":"deck_code_mode","arguments":{
            "stages":[[{"id":"a","tool":"write_file","args":{"path":"allowed","content":"yes"}}],[{"id":"b","tool":"write_file","args":{"path":"denied","content":"no"}}]],
            "output":{"allowed":{"$ref":"a"},"denied":{"$ref":"b"}}
        }}}), "writes", 1).await.unwrap();
        let report: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(report["status"], "partial");
        assert!(report["output"]["allowed"]
            .as_str()
            .unwrap()
            .contains("Created"));
        assert_eq!(report["steps"][1]["status"], "refused");
        assert_eq!(approvals.0.load(Ordering::SeqCst), 2);
        assert_eq!(std::fs::read_to_string(dir.join("allowed")).unwrap(), "yes");
        assert!(!dir.join("denied").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[async_trait::async_trait]
    impl apex_core::Approver for PendingApproval {
        async fn decide(&self, _: apex_core::ProposedAction) -> apex_core::Decision {
            self.0.notify_one();
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn stop_disconnect_and_protocol_cancel_drop_pending_batch() {
        for cause in ["stop", "disconnect", "notification"] {
            let bridge = Bridge::bind().await.unwrap();
            let dir = std::env::temp_dir().join(format!(
                "deck-cancel-{}-{cause}",
                bridge.listener.local_addr().unwrap().port()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let tools = ToolBox::new(&crate::BuildContext {
                cwd: Some(dir.clone()),
                ..Default::default()
            });
            let approvals = PendingApproval(Default::default());
            let progress = |_: apex_core::Progress<'_>| {};
            let mut turn = Turn::new(
                &tools,
                Access::Ask,
                false,
                Access::Ask,
                &approvals,
                &progress,
            );
            let cancel = Cancellation::default();
            let server = bridge.serve(&mut turn, &cancel);
            let client = async {
                let mut socket = tokio::net::TcpStream::connect(&bridge.launch.address)
                    .await
                    .unwrap();
                socket
                    .write_all(format!("{}\n", bridge.launch.token).as_bytes())
                    .await
                    .unwrap();
                let request = json!({"id":9,"method":"tools/call","params":{"name":"deck_code_mode","arguments":{
                    "stages":[[{"id":"a","tool":"write_file","args":{"path":"a","content":"no"}}],[{"id":"b","tool":"write_file","args":{"path":"b","content":"no"}}]],"output":{"$ref":"b"}
                }}});
                socket
                    .write_all(format!("{request}\n").as_bytes())
                    .await
                    .unwrap();
                approvals.0.notified().await;
                match cause {
                    "stop" => cancel.stop(),
                    "notification" => {
                        socket.write_all(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":9}}\n").await.unwrap();
                    }
                    _ => {
                        socket.shutdown().await.unwrap();
                    }
                }
                let mut byte = [0u8; 1];
                assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
                assert!(!dir.join("a").exists());
                assert!(!dir.join("b").exists());
                cancel.stop();
            };
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let (result, ()) = tokio::join!(server, client);
                result.unwrap();
            })
            .await
            .expect("cancelled approvals must not hang");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn transport_authenticates_and_accepts_pipelined_notifications() {
        let bridge = Bridge::bind().await.unwrap();
        let tools = ToolBox::new(&crate::BuildContext::default());
        let progress = |_: apex_core::Progress<'_>| {};
        let mut turn = Turn::new(
            &tools,
            Access::Read,
            false,
            Access::Read,
            &NoApprover,
            &progress,
        );
        let cancel = Cancellation::default();
        let client = async {
            let mut invalid = tokio::net::TcpStream::connect(&bridge.launch.address)
                .await
                .unwrap();
            invalid.write_all(b"wrong\n").await.unwrap();
            let mut byte = [0u8; 1];
            assert_eq!(invalid.read(&mut byte).await.unwrap(), 0);
            let mut socket = tokio::net::TcpStream::connect(&bridge.launch.address)
                .await
                .unwrap();
            socket.write_all(format!("{}\n{}\n{}\n{}\n",bridge.launch.token,
                json!({"id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),
                json!({"method":"notifications/initialized"}), json!({"id":2,"method":"tools/list"})).as_bytes()).await.unwrap();
            let mut reader = BufReader::new(socket);
            let init: Value =
                serde_json::from_str(&line(&mut reader).await.unwrap().unwrap()).unwrap();
            assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
            let catalog: Value =
                serde_json::from_str(&line(&mut reader).await.unwrap().unwrap()).unwrap();
            assert_eq!(catalog["result"]["tools"][0]["name"], "deck_code_mode");
            let flags = bridge.launch.codex_flags(Path::new("/Apex Deck/helper"));
            assert!(!flags.join(" ").contains(&bridge.launch.token));
            assert!(!bridge
                .launch
                .claude_config(Path::new("/helper"))
                .to_string()
                .contains(&bridge.launch.token));
            cancel.stop();
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let (result, ()) = tokio::join!(bridge.serve(&mut turn, &cancel), client);
            result.unwrap();
        })
        .await
        .unwrap();
    }
}
