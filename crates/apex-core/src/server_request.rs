//! Explicit server requests; never changes which servers are enabled.
/// One addressable server, plugin, or app. Aliases are shared by the menu and validation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToolServer {
 pub token: String,
 pub label: String,
 pub aliases: Vec<String>,
}
impl From<String> for ToolServer {
 fn from(name: String) -> Self {
  Self { token: name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-"), label: name.clone(), aliases: vec![name] }
 }
}
impl ToolServer {
 pub fn matches(&self, name: &str) -> bool {
  let key = normalize(name);
  std::iter::once(&self.token).chain(self.aliases.iter()).any(|alias| normalize(alias) == key)
 }
}
pub fn normalize(name: &str) -> String {
 name.to_lowercase().chars().filter(|c| !matches!(c, '-' | '_' | '.') && !c.is_whitespace()).collect()
}
pub fn parse_server_requests(text: &str) -> Vec<String> {
 let chars: Vec<char> = text.chars().collect();
 let mut found = Vec::new(); let mut seen = std::collections::HashSet::new();
 let mut i = 0; let mut delimiter = 0;
 while i < chars.len() {
  if delimiter == 0 && chars[i] == '\\' { i += 2; continue; }
  if chars[i] == '`' {
   let start = i; while i < chars.len() && chars[i] == '`' { i += 1; }
   let count = i - start;
   if delimiter == 0 { delimiter = count; } else if delimiter == count { delimiter = 0; }
   continue;
  }
  if delimiter == 0 && chars[i] == '!' && (i == 0 || chars[i-1].is_whitespace()) {
   let start = i + 1; let mut end = start;
   while end < chars.len() && (chars[end].is_ascii_alphanumeric() || matches!(chars[end], '.' | '_' | '-')) { end += 1; }
   let name: String = chars[start..end].iter().collect();
   let key = normalize(&name);
   if !key.is_empty() && seen.insert(key) { found.push(name); }
   i = end.max(i+1);
  } else { i += 1; }
 }
 found
}
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved { pub matched: Vec<String>, pub unknown: Vec<String> }
pub fn resolve(names: &[String], known: &[ToolServer]) -> Resolved {
 let mut result = Resolved { matched: vec![], unknown: vec![] };
 for name in names {
  if let Some(server) = known.iter().find(|s| s.matches(name)) {
   if !result.matched.contains(&server.token) { result.matched.push(server.token.clone()); }
  } else { result.unknown.push(name.clone()); }
 }
 result
}

pub fn prompt_section(text: &str) -> String {
 let names = parse_server_requests(text);
 if names.is_empty() { String::new() } else { format!("\nThe human asked you to use these MCP servers, apps, or installed plugins: {}.\n", names.join(", ")) + "Resolve each name against your available servers, app connector identities, and installed plugins. For an app, use its tools within codex_apps; for a plugin, follow its available skills and use its associated tools. Do not assume an app or plugin name is a literal MCP server name. If the requested capability is unavailable, tell the human. This request does not enable servers or bypass approvals.\n" }
}
