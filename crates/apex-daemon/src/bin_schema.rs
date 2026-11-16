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
            "DevicesRequest": schemars::schema_for!(apex_daemon::protocol::DevicesRequest),
            "GatewayAdminRequest": schemars::schema_for!(apex_daemon::gateway_admin::Request),
            "KeysRequest": schemars::schema_for!(apex_daemon::gateway_cli::KeysRequest),
            "MaintenanceRequest": schemars::schema_for!(apex_daemon::maintenance::Request),
            "PairRequest": schemars::schema_for!(apex_daemon::pair_commands::PairRequest),
            "VoiceRequest": schemars::schema_for!(apex_daemon::voice::session::VoiceRequest),
            "Welcome": schemars::schema_for!(apex_daemon::protocol::Welcome),
        }
    });
    println!("{}", serde_json::to_string_pretty(&doc).expect("a schema is JSON"));
}
