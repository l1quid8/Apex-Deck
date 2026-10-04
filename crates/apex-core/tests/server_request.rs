use apex_core::server_request::{parse_server_requests, resolve};
#[test]
fn parsing_matches_composer_boundaries() {
 assert_eq!(parse_server_requests("!x-mcp !X_MCP wow! != ![img](url) !! \\!skip `!code` ```\n!hidden\n``` !Hyper-MCP"), vec!["x-mcp", "Hyper-MCP"]);
}
#[test]
fn resolves_original_names_and_typos() {
 let got = resolve(&["hyper_mcp".into(), "x-mpc".into()], &[String::from("Hyper MCP").into()]);
 assert_eq!(got.matched, vec!["hyper-mcp"]);
 assert_eq!(got.unknown, vec!["x-mpc"]);
}

#[test]
fn aliases_resolve_to_one_plugin_token() {
 use apex_core::server_request::ToolServer;
 let known = vec![ToolServer { token: "computer-use".into(), label: "Computer Use".into(), aliases: vec!["native_control".into(), "Computer Use".into()] }];
 let got = resolve(&["native-control".into(), "Computer-Use".into()], &known);
 assert_eq!(got.matched, vec!["computer-use"]);
 assert!(got.unknown.is_empty());
}
