//! Explicit live smoke check: cargo run -p apex-adapters --example decision-smoke -- jev /path/to/key
use apex_adapters::decision::{DecisionConfig, HttpDecisionProvider};
use apex_core::{decision::{thinking_request, DecisionProvider}, Message, ParticipantConfig, Speaker};
#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    let provider = args.get(1).ok_or("Provide provider and key file path")?;
    let key = std::fs::read_to_string(args.get(2).ok_or("Provide key file path")?).map_err(|_| "Could not read key file")?;
    let client = HttpDecisionProvider::new(DecisionConfig { provider: provider.clone(), account_id: args.get(3).cloned().unwrap_or_default() }, key)?;
    let messages = [Message { seq: 0, at: None, servers: vec![], speaker: Speaker::Human, text: "Can one of you explain this build error?".into() }];
    let bot = |id: &str, name: &str| -> Result<ParticipantConfig, String> {
        serde_json::from_value(serde_json::json!({"id":id,"display_name":name,"backend":{"kind":"scripted","lines":[]}})).map_err(|e| e.to_string())
    };
    let request = thinking_request(&messages, &[bot("engineer", "Engineer")?, bot("reviewer", "Reviewer")?]);
    let result = client.decide(request).await?;
    println!("{}", serde_json::to_string(&result).map_err(|_| "Could not encode result")?);
    Ok(())
}
