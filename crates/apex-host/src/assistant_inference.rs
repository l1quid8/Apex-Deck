//! Assistant conversation inference. Task execution stays in personal_worker.
use apex_core::{Backend, ParticipantConfig, Reply, TurnRequest};

/// A computer reply can wait on the user's app prompts and on slow apps.
const COMPUTER_LIMIT_SECONDS: u64 = 15 * 60;

/// What a reply did with its computer tools.
#[derive(Default)]
pub(crate) struct ComputerUse { pub used: bool, pub text_only: bool }

pub(crate) async fn reply(config: ParticipantConfig, request: TurnRequest, attachment_roots: Vec<std::path::PathBuf>) -> Result<(Reply, ComputerUse), String> {
    apex_adapters::assistant_profile_ok(&config)?;
    if let Backend::OpenAiCompatible { base_url, model, api_key_env } = &config.backend {
        if let Some(name)=api_key_env {
            if apex_adapters::keys::lookup(name).is_none() { return Err("This assistant’s provider credential is missing on this machine. Connect it in Settings.".into()); }
        }
        if apex_adapters::api_model(base_url,api_key_env.as_deref(),model).await.is_some_and(|model|model.kind!=apex_adapters::ModelKind::Text) {
            return Err("Choose a text model for this assistant.".into());
        }
    }
    let computer=request.computer.is_some();
    let limit=if computer {COMPUTER_LIMIT_SECONDS} else if matches!(config.backend,Backend::OpenAiCompatible{..}) {120} else {300};
    let context=apex_adapters::BuildContext { path:crate::agents::login_path(), attachment_roots, ..Default::default() };
    let participant=if computer {apex_adapters::build_computer_assistant(config,&context)?} else {apex_adapters::build_assistant(config,&context)?};
    use std::sync::atomic::{AtomicBool,Ordering::Relaxed};
    let (used,text_only)=(AtomicBool::new(false),AtomicBool::new(false));
    let reply=tokio::time::timeout(std::time::Duration::from_secs(limit),participant.respond_with_progress(request,&|update| {
        // These are the turn's only tools, so any step but thinking is one of them.
        if let apex_core::Progress::Work(step)=update {
            if step.kind!=apex_core::work_steps::StepKind::Thinking {used.store(true,Relaxed);}
            if step.key==crate::personal_worker::TEXT_ONLY_STEP {text_only.store(true,Relaxed);}
        }
    }))
        .await.map_err(|_|"The assistant provider timed out. You can retry or select another provider.".to_string())?
        .map_err(|error|error.to_string())?;
    Ok((reply,ComputerUse{used:used.into_inner(),text_only:text_only.into_inner()}))
}
