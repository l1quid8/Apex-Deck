use apex_cli::{
    history::History,
    input::Editor,
    state::{AppState, Menu},
    terminal::{handle_event, Intent},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Barrier},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("apex-cli-history-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn key(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}
fn recalled(mut history: History) -> Vec<String> {
    let mut editor = Editor::default();
    let mut values = vec![];
    while history.previous(&mut editor) {
        values.push(editor.text.clone());
    }
    values
}

#[test]
fn persistence_keeps_exact_typed_inputs_in_selected_data_directory() {
    let data = Temp::new();
    let other = Temp::new();
    let mut history = History::load(data.path()).unwrap();
    history
        .record(data.path(), "  message 界\nnext line  ")
        .unwrap();
    history.record(data.path(), "/help").unwrap();
    history.record(data.path(), " \n\t ").unwrap();
    assert_eq!(
        recalled(History::load(data.path()).unwrap()),
        ["/help", "  message 界\nnext line  "]
    );
    assert!(recalled(History::load(other.path()).unwrap()).is_empty());
}

#[test]
fn recall_edits_only_the_composer_and_down_restores_exact_draft_caret() {
    let data = Temp::new();
    let mut state = AppState::default();
    state.select("a".into());
    state.input_history.record(data.path(), "oldest").unwrap();
    state.input_history.record(data.path(), "/help").unwrap();
    state.editor.insert("unfinished 界 draft");
    state.editor.cursor = "unfinished 界".len();
    assert_eq!(handle_event(&mut state, key(KeyCode::Up)), Intent::None);
    assert_eq!(state.editor.text, "/help");
    assert!(state.menu.is_none(), "recall must not open command choices");
    state.editor.insert(" edited");
    assert_eq!(handle_event(&mut state, key(KeyCode::Up)), Intent::None);
    assert_eq!(state.editor.text, "oldest");
    assert_eq!(handle_event(&mut state, key(KeyCode::Up)), Intent::None);
    assert_eq!(state.editor.text, "oldest");
    assert_eq!(handle_event(&mut state, key(KeyCode::Down)), Intent::None);
    assert_eq!(
        state.editor.text, "/help",
        "editing a recalled value never rewrites storage"
    );
    assert_eq!(handle_event(&mut state, key(KeyCode::Down)), Intent::None);
    assert_eq!(state.editor.text, "unfinished 界 draft");
    assert_eq!(state.editor.cursor, "unfinished 界".len());
    assert_eq!(handle_event(&mut state, key(KeyCode::Down)), Intent::None);
    assert_eq!(state.editor.cursor, "unfinished 界".len());
}

#[test]
fn switching_threads_during_recall_preserves_the_original_thread_draft() {
    let data = Temp::new();
    let mut state = AppState::default();
    state.select("a".into());
    state
        .input_history
        .record(data.path(), "submitted")
        .unwrap();
    state.editor.insert("thread a draft");
    state.editor.cursor = 3;
    handle_event(&mut state, key(KeyCode::Up));
    assert_eq!(state.editor.text, "submitted");
    state.select("b".into());
    state.editor.insert("thread b draft");
    state.select("a".into());
    assert_eq!(state.editor.text, "thread a draft");
    assert_eq!(state.editor.cursor, 3);
    handle_event(&mut state, key(KeyCode::Down));
    assert_eq!(state.editor.text, "thread a draft");
    state.select("b".into());
    assert_eq!(state.editor.text, "thread b draft");
}

#[test]
fn menus_panels_cards_setup_questions_and_welcome_keep_arrow_ownership() {
    let data = Temp::new();
    for mode in [
        "answer",
        "workspace",
        "setup",
        "wizard",
        "menu",
        "settings",
        "card",
        "welcome",
    ] {
        let mut state = AppState::default();
        state.select("a".into());
        state
            .input_history
            .record(data.path(), "secret previous input")
            .unwrap();
        match mode {
            "answer" => state.answering = true,
            "workspace" => state.workspace_prompt = true,
            "setup" => state.setup = Some("login codex".into()),
            "wizard" => {
                state.agent_wizard = Some(apex_cli::agent_setup::Wizard::new("codex".into(), 0))
            }
            "menu" => {
                state.menu = Some(Menu {
                    title: "test".into(),
                    choices: vec![],
                    selected: 0,
                    completion: true,
                })
            }
            "settings" => state.settings = Some(Default::default()),
            "card" => state.card = Some(Default::default()),
            "welcome" => state.view = 0,
            _ => unreachable!(),
        }
        for code in [KeyCode::Up, KeyCode::Down] {
            handle_event(&mut state, key(code));
        }
        assert!(state.editor.text.is_empty(), "{mode}");
    }
}

#[test]
fn multiline_boundary_arrows_recall_only_at_first_and_last_lines() {
    let data = Temp::new();
    let mut state = AppState::default();
    state.select("a".into());
    state.input_history.record(data.path(), "old").unwrap();
    state.editor.insert("first\nlast");
    state.editor.cursor = "first\nla".len();
    handle_event(&mut state, key(KeyCode::Up));
    assert_eq!(state.editor.text, "first\nlast");
    assert_eq!(state.editor.cursor, 2);
    handle_event(&mut state, key(KeyCode::Up));
    assert_eq!(state.editor.text, "old");
    handle_event(&mut state, key(KeyCode::Down));
    assert_eq!(state.editor.text, "first\nlast");
    assert_eq!(state.editor.cursor, 2);
    handle_event(&mut state, key(KeyCode::Down));
    assert_eq!(state.editor.cursor, "first\nla".len());
}

#[test]
fn persisted_history_drops_oldest_inputs_at_entry_and_encoded_byte_bounds() {
    let data = Temp::new();
    let mut history = History::default();
    for i in 0..505 {
        history
            .record(data.path(), &format!("message {i}"))
            .unwrap();
    }
    let values = recalled(History::load(data.path()).unwrap());
    assert_eq!(values.len(), 500);
    assert_eq!(values.first().unwrap(), "message 504");
    assert_eq!(values.last().unwrap(), "message 5");
    // JSON escaping expands each tab to two bytes. Bound the actual file,
    // rather than only the length of the decoded strings.
    for i in 0..12 {
        history
            .record(
                data.path(),
                &format!("{i}:{}", "\t".repeat(256 * 1024 - 16)),
            )
            .unwrap();
    }
    let stored = fs::read(data.path().join("cli-input-history.json")).unwrap();
    assert!(stored.len() <= 2 * 1024 * 1024);
    let values = recalled(History::load(data.path()).unwrap());
    assert!(values[0].starts_with("11:"));
    assert!(values.len() < 12);
}

#[test]
fn concurrent_clients_keep_every_committed_input() {
    let data = Temp::new();
    let barrier = Arc::new(Barrier::new(6));
    let workers: Vec<_> = (0..6)
        .map(|worker| {
            let path = data.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut history = History::load(&path).unwrap();
                barrier.wait();
                for i in 0..12 {
                    history.record(&path, &format!("{worker}-{i}")).unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let values = recalled(History::load(data.path()).unwrap());
    assert_eq!(values.len(), 72);
    for worker in 0..6 {
        for i in 0..12 {
            assert!(values.contains(&format!("{worker}-{i}")));
        }
    }
}

#[cfg(unix)]
#[test]
fn history_files_are_private_and_symlinks_cannot_redirect_reads_or_writes() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let data = Temp::new();
    let mut history = History::load(data.path()).unwrap();
    history.record(data.path(), "private message").unwrap();
    for name in ["cli-input-history.json", "cli-input-history.lock"] {
        assert_eq!(
            fs::metadata(data.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let outside = Temp::new();
    let target = outside.path().join("untouched.json");
    fs::write(&target, "[\"outside\"]").unwrap();
    for name in ["cli-input-history.json", "cli-input-history.lock"] {
        let path = data.path().join(name);
        fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();
        assert!(History::load(data.path()).is_err(), "{name}");
        assert!(
            history.record(data.path(), "must not redirect").is_err(),
            "{name}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "[\"outside\"]");
        fs::remove_file(&path).unwrap();
    }
}

#[test]
fn malformed_and_oversized_history_is_not_overwritten() {
    let data = Temp::new();
    let path = data.path().join("cli-input-history.json");
    fs::write(&path, "broken JSON").unwrap();
    let mut history = History::default();
    assert!(History::load(data.path()).is_err());
    assert!(history.record(data.path(), "new").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "broken JSON");
    fs::write(&path, vec![b' '; 2 * 1024 * 1024 + 1]).unwrap();
    assert!(History::load(data.path()).is_err());
    assert!(history.record(data.path(), "new").is_err());
    assert_eq!(fs::metadata(&path).unwrap().len(), 2 * 1024 * 1024 + 1);
}
