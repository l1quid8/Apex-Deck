//! Private desktop pipe. Keys and invitations arrive on stdin, never argv.
use apex_remote::{Bridge, Mode};
use serde_json::Value;
use std::{io::{BufRead, Write}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use zeroize::Zeroizing;

pub fn run() -> Result<(), String> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let bridge = Bridge::new(runtime.handle().clone(), None, Arc::new(|event| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{event}");
        let _ = out.flush();
    }));
    let stdin = std::io::stdin();
    let mut input = stdin.lock().lines();
    let first = Zeroizing::new(input.next().ok_or("Missing configuration")?.map_err(|e| e.to_string())?);
    let mut config: Value = serde_json::from_str(&first).map_err(|_| "Invalid configuration")?;
    let key_text = config.get_mut("key").and_then(Value::as_array_mut).ok_or("Missing key")?;
    let mut key = Zeroizing::new([0u8; 32]);
    if key_text.len() != 32 { return Err("Invalid key".into()); }
    for (out, byte) in key.iter_mut().zip(key_text.iter()) {
        *out = byte.as_u64().filter(|n| *n < 256).ok_or("Invalid key")? as u8;
    }
    config["key"] = Value::Null;
    runtime.block_on(bridge.set_mode(key, Mode::Automatic))?;
    let handle = if config["op"] == "pair" {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
        bridge.pair(config["link"].as_str().ok_or("Missing invitation")?, config["label"].as_str().unwrap_or("Apex Deck desktop"), now)?
    } else if config["op"] == "connect" {
        let addrs = config["addrs"].as_array().ok_or("Missing addresses")?.iter().map(|a| a.as_str().map(String::from).ok_or("Invalid address")).collect::<Result<Vec<_>, _>>()?;
        bridge.connect(config["hostEndpointId"].as_str().ok_or("Missing host")?, &addrs)?
    } else { return Err("Invalid operation".into()); };
    for line in input {
        let line = line.map_err(|e| e.to_string())?;
        bridge.send(handle, line)?;
    }
    runtime.block_on(bridge.shutdown());
    Ok(())
}
