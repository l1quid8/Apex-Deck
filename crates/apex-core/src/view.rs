use serde::{Deserialize, Serialize};

use crate::mention::mention_for;
use crate::types::{Access, Message, ParticipantConfig, ParticipantId, Speaker};

/// A bot replies with exactly this when it has nothing to add. The room
/// drops the reply instead of adding it to the transcript.
pub const PASS_TOKEN: &str = "[pass]";

/// How a compacted chat's summary is introduced to the models.
const SUMMARY_LABEL: &str = "[Summary of the earlier conversation]";

/// Instructions for the turn that summarizes a chat for `/compact`.
pub const COMPACT_SYSTEM: &str = "You summarize a group chat between a human and several AI models. \
Your summary replaces the older messages for every model in the chat, so keep what is needed to carry on: \
what the human wants, decisions and who made them, work done (files, commands, results), open questions \
and next steps. Keep names, @handles, file paths and exact values. Leave out greetings and small talk. \
Write compact plain notes. Do not use tools, do not address anyone, and do not add a preamble.";

/// The request that ends the conversation handed to the summarizer.
pub const COMPACT_ASK: &str = "Write the summary of the conversation above now.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// One turn of the transcript as a single participant sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewTurn {
    pub role: Role,
    pub content: String,
}

pub(crate) fn display_name<'a>(id: &ParticipantId, roster: &'a [ParticipantConfig]) -> &'a str {
    roster
        .iter()
        .find(|c| &c.id == id)
        .map(|c| c.display_name.as_str())
        .unwrap_or("Former participant")
}

/// The instructions given to `me` at the start of every turn.
pub fn system_prompt(me: &ParticipantConfig, roster: &[ParticipantConfig]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "You are {} (@{}), one of several AI models in a group chat with a human.\n",
        me.display_name,
        mention_for(me)
    ));

    let others: Vec<String> = roster
        .iter()
        .filter(|c| c.id != me.id)
        .map(|c| format!("{} (@{})", c.display_name, mention_for(c)))
        .collect();
    if others.is_empty() {
        out.push_str("You are the only model in the room right now.\n");
    } else {
        out.push_str(&format!("The other models are: {}.\n", others.join(", ")));
    }

    out.push_str(
        "Messages from the human and from other models arrive with the speaker's name in square \
         brackets, like \"[Human]: ...\". Do not put your own name in front of your replies.\n\
         To ask another model something, write its @handle. Only do that when you need its input.\n",
    );
    out.push_str(&format!(
        "If you have nothing useful to add, reply with exactly {PASS_TOKEN} and nothing else.\n"
    ));
    out.push_str(match me.access {
        Access::Read => "You may read the workspace but must not change any files.\n",
        Access::Ask => "You may edit files and run commands in the workspace. Each one is shown to the person for approval before it happens, and they may refuse it.\n",
        Access::Edits => "You may edit files in the workspace.\n",
        Access::Full => "You may edit files and run commands in the workspace.\n",
    });

    let persona = me.persona.trim();
    if !persona.is_empty() {
        out.push('\n');
        out.push_str(persona);
        out.push('\n');
    }
    out
}

/// Added to every bot's instructions. Cards always render, so the guidance
/// is always on. tests/answer-guidance.test.mjs reads the example card out of this
/// raw string and checks it against src/interactiveAnswers/schema.ts.
pub const ANSWERS_SYSTEM: &str = r#"

Interactive answers are on. When the human must weigh 2 to 6 options on numbers they may want to adjust (a budget, a size, which quality matters most), you may end your reply with one comparison card. Write your full answer in words first; the card only lets them explore it. Don't add a card to a simple answer.
A card is a fenced code block whose language is apex-ui, holding one JSON object and nothing else. For example:
```apex-ui
{"schemaVersion":1,"kind":"comparison","cardId":"hosting","title":"Where should this run?","summary":"Managed hosting fits most budgets with the least upkeep.","inputs":[{"id":"budget","type":"range","label":"Monthly budget","min":50,"max":500,"step":25,"default":250,"unit":"$"},{"id":"priority","type":"choice","label":"Priority","options":[{"id":"cost","label":"Cost"},{"id":"ease","label":"Simplicity"}],"default":"ease"}],"rows":[{"id":"price","label":"Monthly cost","unit":"$","better":"lower"},{"id":"ease","label":"Ease, 1 to 5","better":"higher"},{"id":"work","label":"Upkeep"}],"options":[{"id":"vps","label":"VPS","values":{"price":60,"ease":2,"work":"High"},"note":"You own updates and backups."},{"id":"managed","label":"Managed","values":{"price":180,"ease":5,"work":"Low"}},{"id":"serverless","label":"Serverless","values":{"price":90,"ease":4,"work":"Medium"},"note":"Cost grows with traffic."}],"rules":[{"type":"atMost","input":"budget","row":"price"},{"type":"rankBy","input":"priority","rows":{"cost":"price","ease":"ease"}}],"assumptions":["Prices are estimates for one small web app."],"sources":[{"label":"Provider pricing","url":"https://example.com/pricing"}]}
```
Ids are lowercase letters, digits, - and _. Values are numbers or short text. The first row shows largest. "atMost" and "atLeast" put an option out when its row is above or below a range input. "rankBy" names, for each choice, the row that ranks the options; that row needs "better": "lower" or "higher". Rules only use rows where every option has a number. At most 4 inputs, 6 options and 12 rows. To revise a card, yours or another model's, reuse its cardId. Comparison cards never contain code, HTML or instructions; the app draws them and does the math.
"#;


/// Adapted from the pinned OpenIntelligentUI prompt.py and master-playbook,
/// advanced-visualization and svg-diagrams playbooks. Full MIT notice is kept
/// in third_party/open-intelligent-ui/LICENSE and packaged third-party notices.
/// Selected from the requesting client's verified runtime capability.
pub const GENERATED_ANSWERS_SYSTEM: &str = r#"

Interactive answers are on for a client whose generated runtime has been verified. Respond to the actual task, not with a product demo. Use plain prose for direct facts, writing, code, conversation, and simple advice. Keep comparison cards for 2 to 6 numeric options whose inputs or priorities the person may want to adjust; their existing schema, formulas, limits, and nonexecutable rules still apply. Use one generated card when a purpose-built calculator, chart, explorer, or inline SVG diagram communicates the answer better. Do not turn every answer into a dashboard. Write the useful answer in prose first so unsupported phone/browser clients can still understand it.

A generated card is one completed apex-ui fenced JSON object, with exactly nine required keys: schemaVersion (1), kind ("generated"), cardId, title, summary, html, css, js, fallback. No extra fields, partial fragments, tools, or streaming execution. cardId is 1 to 40 lowercase letters/digits/-/_. Title is 1 to 80 characters, summary is 1 to 280, and fallback is 1 to 4,000 nonblank characters rendered as plain text. html is a nonblank body fragment; css and js are strings that may be empty. Decoded limits in UTF-8 bytes: html 49,152, css 16,384, js 32,768, all three combined 65,536. Serialized fence JSON must be at most 131,072 UTF-8 bytes AND 131,072 JavaScript UTF-16 code units. Embedded data assets count. Reuse cardId for a revision. The newest complete valid interface opens automatically when fully visible in the focused desktop chat; no initial Run click is required. Stop and Restart remain trusted Deck controls. Never claim a card has executed or an external action succeeded merely because you emitted its JSON.

The fixed frame already contains the adapted OpenIntelligentUI theme variables, semantic colors, SVG classes, and form styles. Build on them: --color-background-primary/secondary/tertiary, --color-text-primary/secondary/tertiary and info/danger/success/warning colors; --font-sans/serif/mono; --border-radius-md/lg/xl. SVG text classes .t/.ts/.th, shapes .box/.node, paths .arr/.leader and semantic ramps .c-purple/.c-teal/.c-coral/.c-pink/.c-gray/.c-blue/.c-green/.c-amber/.c-red are available. Use compact flex/grid layout; css holds widget-specific styles. Form basics are already styled.

Deliver readable html body markup without html/head/body/DOCTYPE wrappers, style blocks, monolithic scripts, executable attributes, or file/credential controls. Put behavior declarations AND their synchronous setup invocation in the single js string. It runs exactly once after the complete markup and styles mount. Static SVG uses empty js. Only built-in HTML/SVG/canvas and browser JavaScript are available. No libraries, imports, CDNs, maps/remote photos, URLs for network resources, fetch/XHR/beacon/WebSocket/WebRTC, workers, nested frames, popups/navigation/downloads, eval/Function, or top-level await. No parent/top DOM, Deck/daemon APIs, Node/preload/IPC, storage/cookies/IndexedDB, files/pickers/drop, clipboard, device/media, keys, drafts, or bot access. Do not invent service endpoints. No state persists across runs.

Data and calculations: label user inputs, calculated results, retrieved sources, and illustrative values. Never invent current weather, prices, metrics, or source links. Use clearly labeled sample assumptions when essential data is unavailable. State units, formula, and bounds inside the card. Validate with valueAsNumber, Number.isFinite, domain limits, blank checks, and nonzero denominators; never show NaN/Infinity or stale output as valid. Preserve internal precision and format outputs. Defaults and Reset restore controls and results together. Filtering, sorting, sliders, and computation stay local; sorting retains the active filter. Every enabled control must work. Use textContent for user/retrieved strings.

Accessible output: semantic headings, associated visible labels, keyboard buttons, visible focus, role=status feedback, and responsive wrapping grids. SVG needs an accessible title/description, width=100%, and viewBox; canvas needs a text summary or data table. Use labels/patterns as well as color. Prefer SVG/HTML when simpler; maintain one animation loop, pause/reset it, and respect reduced motion. Do not repeatedly recreate charts on every input.

Diagram layout: use a 680-wide viewBox, 40px outer margins, compute height from the bottom-most element plus padding, and keep labels within boxes. Estimate title width as characters*8px and subtitle width as characters*7px, with 48px horizontal padding. Use 14px labels and 12px subtitles, weights 400/500, sentence case, text-anchor=middle and dominant-baseline=central for centered text. Keep 24px box padding, 12px text clearance, and up to 4-5 nodes per row; connectors use fill=none and 1.5px stroke. Use 2-3 semantic colors per diagram, not a rainbow sequence.

There is no sending/open-link bridge. A generated button may call window.generatedUI.discuss(text) to stage nonblank plain text of at most 4,000 characters. The person must inspect it and click trusted Deck Discuss to append it to the draft; Send is a separate human action. Never claim a message or external action succeeded, and never stage a discussion on load, timers, or ordinary input changes.

Fixture examples (self-contained; explanatory prose outside the card remains essential):
```apex-ui
{"schemaVersion":1,"kind":"generated","cardId":"unit-cost","title":"Unit cost calculator","summary":"Compare a total price with the number of units.","html":"<label for=\"amount\">Total price ($)</label><input id=\"amount\" type=\"number\" min=\"0\" max=\"1000000\" value=\"24\"><label for=\"units\">Units</label><input id=\"units\" type=\"number\" min=\"1\" max=\"1000000\" value=\"6\"><button id=\"calculate\" type=\"button\">Calculate</button><button id=\"reset\" type=\"button\">Reset</button><output id=\"result\" role=\"status\">$4.00 per unit</output><p>Formula: total price / units. Inputs last only during this run.</p>","css":"body { display: grid; gap: 0.5rem; }","js":"const amount = document.getElementById('amount'); const units = document.getElementById('units'); const result = document.getElementById('result'); function calculate() { const a = amount.valueAsNumber; const n = units.valueAsNumber; if (!Number.isFinite(a) || a < 0 || a > 1000000 || !Number.isFinite(n) || n <= 0 || n > 1000000) { result.textContent = 'Enter a price from 0 to 1,000,000 and more than zero units.'; return; } result.textContent = '$' + (a / n).toFixed(2) + ' per unit'; } document.getElementById('calculate').onclick = calculate; document.getElementById('reset').onclick = () => { amount.value = '24'; units.value = '6'; calculate(); }; calculate();","fallback":"The default total is $24 for 6 units: $4.00 per unit. Divide total price by a positive number of units; Reset returns to these defaults."}
```

```apex-ui
{"schemaVersion":1,"kind":"generated","cardId":"sample-bars","title":"Sample output by quarter","summary":"Illustrative output grows from 12 to 24 units across three quarters.","html":"<p>Sample data, not live results. Q1: 12 units; Q2: 18 units; Q3: 24 units.</p><button id=\"reverse\" type=\"button\">Reverse order</button><button id=\"reset\" type=\"button\">Reset</button><svg id=\"bars\" width=\"100%\" viewBox=\"0 0 680 240\" role=\"img\" aria-label=\"Sample output by quarter\"></svg>","css":"svg { display: block; }","js":"const rows = [{label:'Q1',value:12},{label:'Q2',value:18},{label:'Q3',value:24}]; const svg = document.getElementById('bars'); let reversed = false; function draw() { svg.replaceChildren(); const shown = reversed ? [...rows].reverse() : rows; shown.forEach((row, i) => { const g = document.createElementNS('http://www.w3.org/2000/svg','g'); g.setAttribute('class','c-blue'); const rect = document.createElementNS(g.namespaceURI,'rect'); rect.setAttribute('x','90'); rect.setAttribute('y',String(30+i*65)); rect.setAttribute('width',String(row.value*20)); rect.setAttribute('height','35'); const text = document.createElementNS(g.namespaceURI,'text'); text.setAttribute('x','40'); text.setAttribute('y',String(52+i*65)); text.setAttribute('class','t'); text.textContent = row.label; const value = document.createElementNS(g.namespaceURI,'text'); value.setAttribute('x',String(100+row.value*20)); value.setAttribute('y',String(52+i*65)); value.setAttribute('class','t'); value.textContent = String(row.value); g.append(rect,text,value); svg.append(g); }); } document.getElementById('reverse').onclick = () => { reversed = !reversed; draw(); }; document.getElementById('reset').onclick = () => { reversed = false; draw(); }; draw();","fallback":"Sample values: Q1 = 12 units, Q2 = 18 units, Q3 = 24 units. The bars display these illustrative values; Reverse order changes their order, and Reset restores Q1, Q2, Q3."}
```

```apex-ui
{"schemaVersion":1,"kind":"generated","cardId":"decision-flow","title":"Choosing the answer format","summary":"Use prose for a fact, comparison for numeric choices, and a generated card for a working tool.","html":"<svg width=\"100%\" viewBox=\"0 0 680 200\" role=\"img\" aria-labelledby=\"flow-title flow-desc\" xmlns=\"http://www.w3.org/2000/svg\"><title id=\"flow-title\">Answer format decision flow</title><desc id=\"flow-desc\">Start with the task. Direct fact: prose. Numeric options: comparison. Working controls: generated card.</desc><defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"8\" refY=\"5\" markerWidth=\"6\" markerHeight=\"6\" orient=\"auto-start-reverse\"><path d=\"M2 1L8 5L2 9\" fill=\"none\" stroke=\"context-stroke\" stroke-width=\"1.5\"/></marker></defs><g class=\"box c-gray\"><rect x=\"250\" y=\"20\" width=\"180\" height=\"44\" rx=\"8\"/><text class=\"th\" x=\"340\" y=\"42\" text-anchor=\"middle\" dominant-baseline=\"central\">Read the task</text></g><path class=\"arr\" d=\"M340 64V95H130V130 M340 95V130 M340 95H550V130\" marker-end=\"url(#arrow)\"/><g class=\"box c-teal\"><rect x=\"40\" y=\"130\" width=\"180\" height=\"44\" rx=\"8\"/><text class=\"th\" x=\"130\" y=\"152\" text-anchor=\"middle\" dominant-baseline=\"central\">Fact: prose</text></g><g class=\"box c-blue\"><rect x=\"250\" y=\"130\" width=\"180\" height=\"44\" rx=\"8\"/><text class=\"th\" x=\"340\" y=\"152\" text-anchor=\"middle\" dominant-baseline=\"central\">Options: comparison</text></g><g class=\"box c-purple\"><rect x=\"460\" y=\"130\" width=\"180\" height=\"44\" rx=\"8\"/><text class=\"th\" x=\"550\" y=\"152\" text-anchor=\"middle\" dominant-baseline=\"central\">Tool: generated</text></g></svg>","css":"","js":"","fallback":"Choose prose for direct facts, comparison cards for numeric option tradeoffs, and generated cards when working custom controls or a diagram help explain the task."}
```
"#;

/// This enum is not a wire field. Only the validated hello session selects it;
/// it is carried by each accepted turn chain and never saved in a room.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GeneratedUiCapability {
    #[default]
    Unsupported,
    Verified,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_ui: Option<GeneratedUiClientCapability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedUiClientCapability {
    pub protocol_version: u32,
    pub adapter_version: String,
    pub security_policy_version: String,
    pub electron_version: String,
    pub chromium_version: String,
    pub platform: String,
    pub arch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedUiRuntimePolicy {
    protocol_version: u32,
    adapter_version: String,
    security_policy_version: String,
    verified_runtime_builds: Vec<GeneratedUiRuntimeBuild>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedUiRuntimeBuild {
    electron_version: String,
    chromium_version: String,
    platform: String,
    arch: String,
}

/// The reviewed registry, parsed once. A malformed registry approves nothing;
/// `registry_parses` keeps that from shipping unnoticed.
static GENERATED_UI_RUNTIME_POLICY: std::sync::LazyLock<Option<GeneratedUiRuntimePolicy>> = std::sync::LazyLock::new(||
    serde_json::from_str(include_str!("../../../shared/generated-ui-runtime.json")).ok());

impl ClientCapabilities {
    pub fn generated_ui_capability(&self) -> GeneratedUiCapability {
        let Some(claim) = &self.generated_ui else { return GeneratedUiCapability::Unsupported; };
        if GENERATED_UI_RUNTIME_POLICY.as_ref().is_some_and(|policy| claim.matches_policy(policy)) {
            GeneratedUiCapability::Verified
        } else {
            GeneratedUiCapability::Unsupported
        }
    }
}

impl GeneratedUiClientCapability {
    fn matches_policy(&self, policy: &GeneratedUiRuntimePolicy) -> bool {
        self.protocol_version == policy.protocol_version
            && self.adapter_version == policy.adapter_version
            && self.security_policy_version == policy.security_policy_version
            && policy.verified_runtime_builds.iter().any(|build|
                self.electron_version == build.electron_version && self.chromium_version == build.chromium_version
                && self.platform == build.platform && self.arch == build.arch)
    }
}

/// Verified only for a client whose hello named a tuple in shared/generated-ui-runtime.json.
pub fn answers_system_for_capability(capability: GeneratedUiCapability) -> &'static str {
    static VERIFIED: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| format!("{ANSWERS_SYSTEM}{GENERATED_ANSWERS_SYSTEM}"));
    match capability {
        GeneratedUiCapability::Unsupported => ANSWERS_SYSTEM,
        GeneratedUiCapability::Verified => &VERIFIED,
    }
}

/// The longest fact `/pin` accepts. Pins are sent on every turn.
pub const MAX_PIN_CHARS: usize = 500;

/// Facts the person pinned, for the end of every system prompt. Empty when
/// nothing is pinned.
pub fn pinned_section(pins: &[String]) -> String {
    if pins.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nThe human pinned these facts for this chat. Treat them as standing instructions:\n");
    for pin in pins {
        out.push_str(&format!("- {pin}\n"));
    }
    out
}

/// Turn the shared transcript into the alternating user and assistant turns
/// that chat APIs expect, from the point of view of `me`.
///
/// `me`'s own messages become assistant turns. Everything else becomes a
/// user turn labelled with the speaker's name. Neighbouring turns with the
/// same role are merged, and the result always starts with a user turn.
pub fn render_view(
    transcript: &[Message],
    me: &ParticipantId,
    roster: &[ParticipantConfig],
) -> Vec<ViewTurn> {
    render_view_after(None, transcript, me, roster)
}

/// Like `render_view`, but the conversation opens with `summary`, which
/// stands in for messages that came before `transcript`.
pub fn render_view_after(
    summary: Option<&str>,
    transcript: &[Message],
    me: &ParticipantId,
    roster: &[ParticipantConfig],
) -> Vec<ViewTurn> {
    render_view_hiding(summary, transcript, &[], me, roster)
}

pub fn render_view_hiding(summary: Option<&str>, transcript: &[Message], hidden: &[[usize; 2]], me: &ParticipantId, roster: &[ParticipantConfig]) -> Vec<ViewTurn> {
    let mut turns: Vec<ViewTurn> = Vec::new();
    if let Some(summary) = summary {
        turns.push(ViewTurn { role: Role::User, content: format!("{SUMMARY_LABEL}:\n{summary}") });
    }

    let mut previous_hidden = None;
    for message in transcript {
        let range = hidden.iter().find(|[a,b]| *a <= message.seq && message.seq <= *b).copied();
        let (role, content) = if let Some(range) = range {
            if previous_hidden == Some(range) { continue; }
            previous_hidden = Some(range);
            (Role::User, crate::curation::hidden_line(range))
        } else {
            previous_hidden = None;
            match &message.speaker {
            Speaker::Bot(id) if id == me => (Role::Assistant, message.text.clone()),
            Speaker::Bot(id) => (
                Role::User,
                format!("[{}]: {}", display_name(id, roster), message.text),
            ),
            Speaker::Human => (Role::User, format!("[Human]: {}", message.text)),
            }
        };

        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.content.push_str("\n\n");
                last.content.push_str(&content);
            }
            _ => turns.push(ViewTurn { role, content }),
        }
    }

    if matches!(turns.first(), Some(t) if t.role == Role::Assistant) {
        turns.insert(
            0,
            ViewTurn { role: Role::User, content: "(The conversation begins.)".to_string() },
        );
    }
    turns
}

/// Flatten a system prompt and a view into one block of text, for backends
/// that take a single prompt (command-line tools).
pub fn render_prompt(system: &str, turns: &[ViewTurn]) -> String {
    let mut out = String::new();
    out.push_str(system.trim_end());
    out.push_str("\n\n--- Conversation so far ---\n");
    for turn in turns {
        match turn.role {
            Role::User => out.push_str(&turn.content),
            Role::Assistant => {
                out.push_str("[You]: ");
                out.push_str(&turn.content);
            }
        }
        out.push_str("\n\n");
    }
    out.push_str("--- Your reply ---\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Backend;

    #[test]
    fn capability_accepts_only_an_exact_reviewed_policy_and_runtime_tuple() {
        let claim = serde_json::json!({"protocolVersion":1,"adapterVersion":"open-intelligent-ui-8391a94-deck-1","securityPolicyVersion":"generated-ui-deny-all-1","electronVersion":"44.5.1","chromiumVersion":"152.0.7977.130","platform":"darwin","arch":"arm64"});
        // A controlled policy fixture tests tuple matching; it does not modify
        // the production registry or expose an override to the daemon.
        let policy: GeneratedUiRuntimePolicy = serde_json::from_value(serde_json::json!({"protocolVersion":1,"adapterVersion":"open-intelligent-ui-8391a94-deck-1","securityPolicyVersion":"generated-ui-deny-all-1","verifiedRuntimeBuilds":[{"electronVersion":"44.5.1","chromiumVersion":"152.0.7977.130","platform":"darwin","arch":"arm64"}]})).unwrap();
        let parsed: GeneratedUiClientCapability = serde_json::from_value(claim.clone()).unwrap();
        assert!(parsed.matches_policy(&policy));
        for (key, wrong) in [("protocolVersion", serde_json::json!(2)), ("adapterVersion", serde_json::json!("old")), ("securityPolicyVersion", serde_json::json!("old")), ("electronVersion", serde_json::json!("44.5.2")), ("chromiumVersion", serde_json::json!("152.0.7977.131")), ("platform", serde_json::json!("linux")), ("arch", serde_json::json!("x64"))] {
            let mut value = claim.clone(); value[key] = wrong;
            assert!(!serde_json::from_value::<GeneratedUiClientCapability>(value).unwrap().matches_policy(&policy), "mismatched {key}");
        }
        let capabilities = ClientCapabilities { generated_ui: Some(parsed) };
        assert_eq!(capabilities.generated_ui_capability(), GeneratedUiCapability::Unsupported, "an older adapter and policy stay unapproved");
        // The shared registry approves the reviewed adapter and policy on the reviewed runtime only.
        let registry: GeneratedUiRuntimePolicy = serde_json::from_str(include_str!("../../../shared/generated-ui-runtime.json")).unwrap();
        let current = |electron: &str, chromium: &str, platform: &str, arch: &str| ClientCapabilities { generated_ui: Some(GeneratedUiClientCapability {
            protocol_version: registry.protocol_version, adapter_version: registry.adapter_version.clone(),
            security_policy_version: registry.security_policy_version.clone(), electron_version: electron.into(), chromium_version: chromium.into(),
            platform: platform.into(), arch: arch.into(),
        }) }.generated_ui_capability();
        assert_eq!(current("44.5.1", "152.0.7977.130", "darwin", "arm64"), GeneratedUiCapability::Verified);
        assert_eq!(current("44.5.2", "152.0.7977.130", "darwin", "arm64"), GeneratedUiCapability::Unsupported);
        assert_eq!(current("44.5.1", "152.0.7977.131", "darwin", "arm64"), GeneratedUiCapability::Unsupported);
        assert_eq!(current("44.5.1", "152.0.7977.130", "darwin", "x64"), GeneratedUiCapability::Unsupported, "an unexercised architecture stays unapproved");
        assert_eq!(current("44.5.1", "152.0.7977.130", "linux", "arm64"), GeneratedUiCapability::Unsupported, "an unexercised platform stays unapproved");
        let mut extra = claim.clone(); extra["verified"] = serde_json::json!(true);
        assert!(serde_json::from_value::<GeneratedUiClientCapability>(extra).is_err());
        let mut missing = claim.clone(); missing.as_object_mut().unwrap().remove("chromiumVersion");
        assert!(serde_json::from_value::<GeneratedUiClientCapability>(missing).is_err());
        let mut wrong_type = claim; wrong_type["protocolVersion"] = serde_json::json!("1");
        assert!(serde_json::from_value::<GeneratedUiClientCapability>(wrong_type).is_err());
    }

    #[test]
    fn registry_parses() {
        assert!(GENERATED_UI_RUNTIME_POLICY.is_some(), "shared/generated-ui-runtime.json must match GeneratedUiRuntimePolicy");
    }

    #[test]
    fn generated_guidance_requires_explicit_verified_local_capability() {
        assert_eq!(answers_system_for_capability(GeneratedUiCapability::default()), ANSWERS_SYSTEM);
        assert!(!answers_system_for_capability(GeneratedUiCapability::Unsupported).contains("kind\":\"generated"));
        let verified = answers_system_for_capability(GeneratedUiCapability::Verified);
        assert!(verified.ends_with(GENERATED_ANSWERS_SYSTEM));
        assert!(verified.contains("unit-cost"));
        assert!(verified.contains("sample-bars"));
        assert!(verified.contains("decision-flow"));
    }

    fn cfg(id: &str, name: &str) -> ParticipantConfig {
        ParticipantConfig {
            id: ParticipantId::new(id),
            display_name: name.to_string(),
            backend: Backend::Scripted { lines: vec![] },
            persona: String::new(),
            access: Access::Read,
            effort: None,
            speed: None,
            voice: None,
            appearance: None, media: None
        }
    }

    fn msg(seq: usize, speaker: Speaker, text: &str) -> Message {
        Message { origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, late_reply_from: None, servers: vec![], seq, speaker, text: text.to_string(), at: None }
    }

    #[test]
    fn own_messages_are_assistant_and_others_are_labelled_users() {
        let roster = vec![cfg("opus", "Opus"), cfg("grok", "Grok")];
        let transcript = vec![
            msg(0, Speaker::Human, "hello"),
            msg(1, Speaker::Bot(ParticipantId::new("opus")), "hi from opus"),
            msg(2, Speaker::Bot(ParticipantId::new("grok")), "hi from grok"),
            msg(3, Speaker::Human, "thanks"),
        ];

        let view = render_view(&transcript, &ParticipantId::new("opus"), &roster);
        assert_eq!(
            view,
            vec![
                ViewTurn { role: Role::User, content: "[Human]: hello".into() },
                ViewTurn { role: Role::Assistant, content: "hi from opus".into() },
                ViewTurn {
                    role: Role::User,
                    content: "[Grok]: hi from grok\n\n[Human]: thanks".into()
                },
            ]
        );
    }

    #[test]
    fn view_never_starts_with_an_assistant_turn() {
        let roster = vec![cfg("opus", "Opus")];
        let transcript = vec![msg(0, Speaker::Bot(ParticipantId::new("opus")), "first")];
        let view = render_view(&transcript, &ParticipantId::new("opus"), &roster);
        assert_eq!(view[0].role, Role::User);
        assert_eq!(view[1], ViewTurn { role: Role::Assistant, content: "first".into() });
    }

    #[test]
    fn a_summary_opens_the_view_and_the_live_messages_follow() {
        let roster = vec![cfg("opus", "Opus")];
        let transcript = vec![msg(5, Speaker::Bot(ParticipantId::new("opus")), "next")];
        let view = render_view_after(Some("we chose sqlite"), &transcript, &ParticipantId::new("opus"), &roster);
        assert_eq!(
            view,
            vec![
                ViewTurn { role: Role::User, content: format!("{SUMMARY_LABEL}:\nwe chose sqlite") },
                ViewTurn { role: Role::Assistant, content: "next".into() },
            ]
        );
    }

    #[test]
    fn system_prompt_names_the_room_and_the_rules() {
        let mut me = cfg("opus", "Opus");
        me.persona = "Be blunt.".into();
        me.access = Access::Edits;
        let roster = vec![me.clone(), cfg("grok", "Grok")];
        let prompt = system_prompt(&me, &roster);
        assert!(prompt.contains("You are Opus (@opus)"));
        assert!(prompt.contains("Grok (@grok)"));
        assert!(prompt.contains(PASS_TOKEN));
        assert!(prompt.contains("You may edit files in the workspace."));
        assert!(prompt.trim_end().ends_with("Be blunt."));
    }

    #[test]
    fn system_prompt_gives_a_renamed_bot_its_new_mention() {
        let me = cfg("jigga", "Atlas");
        let roster = vec![me.clone(), cfg("qwen3.5-9b--4-bit", "Gwen")];
        let prompt = system_prompt(&me, &roster);
        assert!(prompt.contains("You are Atlas (@atlas)"), "{prompt}");
        assert!(prompt.contains("The other models are: Gwen (@gwen)."), "{prompt}");
        assert!(!prompt.contains("@jigga") && !prompt.contains("@qwen"), "{prompt}");
    }
}
