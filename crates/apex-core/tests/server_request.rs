use apex_core::server_request::{parse_server_requests, resolve};
#[test]
fn parsing_matches_composer_boundaries() {
 assert_eq!(parse_server_requests("!x-mcp !X_MCP wow! != ![img](url) !! \\!skip `!code` ```\n!hidden\n``` !Hyper-MCP"), vec!["x-mcp", "Hyper-MCP"]);
}
#[test]
fn resolves_original_names_and_typos() {
 let got = resolve(&["hyper_mcp".into(), "x-mpc".into()], &["Hyper MCP".into()]);
 assert_eq!(got.matched, vec!["Hyper MCP"]);
 assert_eq!(got.unknown, vec!["x-mpc"]);
}
