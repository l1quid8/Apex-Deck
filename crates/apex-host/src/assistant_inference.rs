//! Assistant conversation inference. Task execution stays in personal_worker.
use apex_core::{Backend, ParticipantConfig, Reply, TurnRequest};

pub(crate) async fn reply(config: ParticipantConfig, request: TurnRequest) -> Result<Reply, String> {
    apex_adapters::assistant_profile_ok(&config)?;
    if let Backend::OpenAiCompatible { base_url, model, api_key_env } = &config.backend {
        if let Some(name)=api_key_env {
            if apex_adapters::keys::lookup(name).is_none() { return Err("This assistant’s provider credential is missing on this machine. Connect it in Settings.".into()); }
        }
        if apex_adapters::api_model(base_url,api_key_env.as_deref(),model).await.is_some_and(|model|model.kind!=apex_adapters::ModelKind::Text) {
            return Err("Choose a text model for this assistant.".into());
        }
    }
    let limit=if matches!(config.backend,Backend::OpenAiCompatible{..}) {120} else {300};
    let context=apex_adapters::BuildContext { path:crate::agents::login_path(), ..Default::default() };
    let participant=apex_adapters::build_assistant(config,&context)?;
    tokio::time::timeout(std::time::Duration::from_secs(limit),participant.respond(request,&|_|{}))
        .await.map_err(|_|"The assistant provider timed out. You can retry or select another provider.".to_string())?
        .map_err(|error|error.to_string())
}
