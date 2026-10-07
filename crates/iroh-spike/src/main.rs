//! Remote-access milestone 1 spike.
//!
//! `listen` runs on the Mac or VPS and echoes pings; `dial` connects with the
//! address `listen` prints and reports every ping's round trip and whether it
//! went Direct or Relayed. Router port mapping is always off, matching the plan.

use std::{path::PathBuf, time::{Duration, Instant}};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use iroh::{
    endpoint::{presets, Connection, PortmapperConfig},
    Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey,
};

const ALPN: &[u8] = b"apex-deck/spike/0";

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print the endpoint ID for a key file, creating the key if missing.
    Id {
        #[arg(long)]
        key: PathBuf,
    },
    /// Accept connections and echo pings.
    Listen {
        #[arg(long)]
        key: PathBuf,
        /// Relay URL, "n0" for n0's public relays, or "none" for Direct only.
        #[arg(long)]
        relay: String,
        /// Fixed UDP port for direct connections (both IPv4 and IPv6).
        #[arg(long)]
        port: Option<u16>,
    },
    /// Connect to a listener and ping it.
    Dial {
        /// Address JSON printed by `listen`, or @path to a file holding it.
        addr: String,
        #[arg(long)]
        key: Option<PathBuf>,
        #[arg(long)]
        relay: String,
        /// Stop after this many pings (runs until Ctrl-C if omitted).
        #[arg(long)]
        count: Option<u64>,
        #[arg(long, default_value_t = 1000)]
        interval_ms: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    match Cli::parse().cmd {
        Cmd::Id { key } => {
            println!("{}", load_or_create_key(&key).await?.public());
            Ok(())
        }
        Cmd::Listen { key, relay, port } => listen(key, &relay, port).await,
        Cmd::Dial { addr, key, relay, count, interval_ms } => {
            dial(&addr, key, &relay, count, Duration::from_millis(interval_ms)).await
        }
    }
}

async fn load_or_create_key(path: &PathBuf) -> Result<SecretKey> {
    if let Ok(hex) = tokio::fs::read_to_string(path).await {
        let bytes = decode_hex(hex.trim())?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    tokio::fs::write(path, hex).await.with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}

fn decode_hex(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        bail!("key file must hold 64 hex characters");
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

async fn bind(key: SecretKey, relay: &str, port: Option<u16>, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let relay_mode = match relay {
        "none" => RelayMode::Disabled,
        "n0" => RelayMode::Default,
        url => RelayMode::Custom(RelayMap::from(url.parse::<RelayUrl>().context("relay URL")?)),
    };
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .relay_mode(relay_mode)
        .portmapper_config(PortmapperConfig::Disabled)
        .alpns(alpns);
    if let Some(port) = port {
        builder = builder
            .clear_ip_transports()
            .bind_addr(format!("0.0.0.0:{port}").as_str())?
            .bind_addr(format!("[::]:{port}").as_str())?;
    }
    Ok(builder.bind().await?)
}

/// "Direct" when the selected path is an IP path, "Relayed" when it is the relay.
fn route(conn: &Connection) -> String {
    let paths = conn.paths();
    match paths.iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => format!("Relayed via {:?}", p.remote_addr()),
        Some(p) => format!("Direct to {:?}", p.remote_addr()),
        None => "no path selected".into(),
    }
}

fn watch_route(conn: Connection, tag: String) {
    tokio::spawn(async move {
        let mut last = String::new();
        loop {
            let now = route(&conn);
            if now != last {
                eprintln!("[{tag}] route: {now} ({} open paths)", conn.paths().len());
                last = now;
            }
            tokio::select! {
                _ = conn.closed() => break,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }
    });
}

async fn listen(key: PathBuf, relay: &str, port: Option<u16>) -> Result<()> {
    let key = load_or_create_key(&key).await?;
    let ep = bind(key, relay, port, vec![ALPN.to_vec()]).await?;
    if relay != "none" {
        tokio::time::timeout(Duration::from_secs(15), ep.online())
            .await
            .map_err(|_| anyhow!("relay not reachable within 15s"))?;
    }
    eprintln!("endpoint id: {}", ep.id());
    eprintln!("bound sockets: {:?}", ep.bound_sockets());
    println!("{}", serde_json::to_string(&ep.addr())?);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            incoming = ep.accept() => {
                let Some(incoming) = incoming else { break };
                tokio::spawn(async move {
                    let conn = match incoming.await {
                        Ok(conn) => conn,
                        Err(err) => return eprintln!("accept failed: {err:#}"),
                    };
                    let tag = conn.remote_id().fmt_short().to_string();
                    eprintln!("[{tag}] connected");
                    watch_route(conn.clone(), tag.clone());
                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        let Ok(data) = recv.read_to_end(64).await else { break };
                        if send.write_all(&data).await.is_err() || send.finish().is_err() {
                            break;
                        }
                    }
                    eprintln!("[{tag}] closed: {:?}", conn.close_reason());
                });
            }
        }
    }
    ep.close().await;
    Ok(())
}

async fn dial(
    addr: &str,
    key: Option<PathBuf>,
    relay: &str,
    count: Option<u64>,
    interval: Duration,
) -> Result<()> {
    let json = match addr.strip_prefix('@') {
        Some(path) => tokio::fs::read_to_string(path).await?,
        None => addr.to_string(),
    };
    let target: EndpointAddr = serde_json::from_str(json.trim()).context("address JSON")?;
    let key = match key {
        Some(path) => load_or_create_key(&path).await?,
        None => SecretKey::generate(),
    };
    let ep = bind(key, relay, None, vec![]).await?;
    eprintln!("dialer id: {}", ep.id());

    let started = Instant::now();
    let conn = ep.connect(target, ALPN).await?;
    eprintln!("connected in {:?}: {}", started.elapsed(), route(&conn));
    watch_route(conn.clone(), "dial".into());

    let mut n = 0u64;
    loop {
        n += 1;
        let sent = Instant::now();
        let result: Result<()> = async {
            let (mut send, mut recv) = conn.open_bi().await?;
            send.write_all(&n.to_be_bytes()).await?;
            send.finish()?;
            let echo = recv.read_to_end(64).await?;
            if echo != n.to_be_bytes() {
                bail!("echo mismatch");
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => println!("ping {n}: {:?} {}", sent.elapsed(), route(&conn)),
            Err(err) => println!("ping {n}: failed: {err:#}"),
        }
        if count.is_some_and(|c| n >= c) {
            break;
        }
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = tokio::time::sleep(interval) => {}
        }
    }
    let stats = conn.stats();
    eprintln!("stats: {stats:?}");
    conn.close(0u32.into(), b"done");
    ep.close().await;
    Ok(())
}
