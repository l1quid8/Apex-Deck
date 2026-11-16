//! `apex-protocol-schema`: the wire types as JSON Schema, on stdout, for
//! `scripts/gen-protocol-types.mjs` to turn into `src/generated/protocol.ts`.
//! Nothing here is read at runtime; the Rust types are the source of truth and
//! CI fails when the generated TypeScript no longer matches them.

fn main() {
    let capabilities: Vec<&str> = apex_daemon::protocol::CAPABILITIES.iter().chain(apex_daemon::protocol::OPTIONAL_CAPABILITIES).copied().collect();
    let doc = serde_json::json!({
        "protocol": apex_daemon::protocol::PROTOCOL,
        "capabilities": capabilities,
        "schemas": {
            "Command": schemars::schema_for!(apex_host::Command),
            "RoomEvent": schemars::schema_for!(apex_core::RoomEvent),
            "HostEvent": schemars::schema_for!(apex_host::events::HostEvent),
            "Welcome": schemars::schema_for!(apex_daemon::protocol::Welcome),
        }
    });
    println!("{}", serde_json::to_string_pretty(&doc).expect("a schema is JSON"));
}
