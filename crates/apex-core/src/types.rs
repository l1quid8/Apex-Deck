use serde::{Deserialize, Serialize};

/// Stable identifier for a participant inside one room. Also used as the
/// `@handle` people and bots type to address it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParticipantId(pub String);

impl ParticipantId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ParticipantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a participant is allowed to do to the workspace it runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// May read files but not change them.
    #[default]
    Read,
    /// May edit files and run commands, but each one is shown to the
    /// person first and only happens if they approve it.
    Ask,
    /// May edit files.
    Edits,
    /// May edit files and run commands.
    Full,
}

/// A coding agent Apex Deck knows how to run without being told the
/// command. The adapter builds the right command line for each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTool {
    ClaudeCode,
    Codex,
    Gemini,
}

/// How a participant is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Backend {
    /// An HTTP API that speaks the OpenAI-style chat completions format.
    /// The API key is looked up at run time from the environment variable
    /// named in `api_key_env`; it is never stored in the config.
    OpenAiCompatible {
        base_url: String,
        model: String,
        #[serde(default)]
        api_key_env: Option<String>,
    },
    /// A known coding agent, run once per turn. `model` is passed to the
    /// tool as given; `None` uses whatever the tool is set up to use.
    Agent {
        tool: AgentTool,
        #[serde(default)]
        model: Option<String>,
    },
    /// A command-line tool run once per turn. The prompt is written to its
    /// standard input and the reply is read from its standard output.
    Cli {
        program: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// A canned participant that needs no model. Useful for demos and tests.
    Scripted {
        #[serde(default)]
        lines: Vec<String>,
    },
}

/// Everything needed to put one bot in a room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParticipantConfig {
    pub id: ParticipantId,
    pub display_name: String,
    pub backend: Backend,
    /// Extra instructions that give this bot its character.
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub access: Access,
    /// How hard the model should think, in the backend's own words (for
    /// example "low" or "high"). `None` leaves the backend's default.
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AgentAppearance>,
}

/// A model a tool offers, for the model picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    /// The name passed to the tool, exactly as it expects it.
    pub id: String,
    /// A friendlier name to show next to the id.
    #[serde(default)]
    pub label: Option<String>,
    /// The effort levels this model accepts. `None` means not known; an
    /// empty list means the model has no effort setting.
    #[serde(default)]
    pub efforts: Option<Vec<String>>,
}

/// Who wrote a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Speaker {
    Human,
    Bot(ParticipantId),
}

/// One entry in the shared transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// Position in the transcript, starting at 0.
    pub seq: usize,
    pub speaker: Speaker,
    pub text: String,
}

/// Saved visual identity; has no effect on model behavior.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAppearance {
    pub seed: String,
    pub color: String,
}
