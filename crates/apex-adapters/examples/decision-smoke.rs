//! Explicit live smoke check: cargo run -p apex-adapters --example decision-smoke -- jev /path/to/key
use apex_adapters::decision::{DecisionConfig, HttpDecisionProvider};
use apex_core::{decision::{routing_request, DecisionProvider}, Message, ParticipantId, Speaker};
#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    let provider = args.get(1).ok_or("Provide provider and key file path")?;
    let key = std::fs::read_to_string(args.get(2).ok_or("Provide key file path")?).map_err(|_| "Could not read key file")?;
    let client = HttpDecisionProvider::new(DecisionConfig { provider: provider.clone(), account_id: args.get(3).cloned().unwrap_or_default() }, key)?;
    let messages = [Message { seq: 0, at: None, servers: vec![], speaker: Speaker::Human, text: "Can one of you explain this build error?".into() }];
    let request = routing_request(&messages, &[ParticipantId::new("engineer"), ParticipantId::new("reviewer")]);
    let result = client.decide(request).await?;
    println!("{}", serde_json::to_string(&result).map_err(|_| "Could not encode result")?);
    Ok(())
}
