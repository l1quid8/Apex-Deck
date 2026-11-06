use apex_cli::input::{clean, Editor};
use apex_cli::{
    state::{AppState, Menu},
    terminal::{handle_event, Intent},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
#[test]
fn paste_and_modified_enter_never_activate_or_send() {
    let mut state = AppState::default();
    assert!(matches!(
        handle_event(
            &mut state,
            Event::Paste("one\ntwo\n/clear\nfour\nfive".into())
        ),
        Intent::None
    ));
    state.menu = Some(Menu {
        title: "test".into(),
        choices: vec![],
        selected: 0,
        completion: true,
    });
    assert!(matches!(
        handle_event(
            &mut state,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT))
        ),
        Intent::None
    ));
    assert!(state.editor.text.ends_with("five\n"));
    assert!(state.menu.is_none());
    assert!(matches!(
        handle_event(
            &mut state,
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        ),
        Intent::Submit
    ));
}
#[test]
fn tiny_and_regular_terminal_layouts_do_not_panic() {
    use ratatui::{backend::TestBackend, Terminal};
    for (w, h) in [(1, 1), (10, 4), (80, 24), (120, 40)] {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        let mut state = AppState::default();
        state.editor.insert("界\ne\u{301}\nlong composer");
        terminal
            .draw(|frame| {
                apex_cli::ui::draw(frame, &state, 0);
            })
            .unwrap();
    }
}
#[test]
fn unicode_edit_and_paste_never_submit() {
    let mut e = Editor::default();
    e.insert("a🦀e\u{301}\n/clear\n");
    assert_eq!(e.text, "a🦀e\u{301}\n/clear\n");
    e.home();
    e.right();
    e.delete();
    assert!(e.text.starts_with("ae"));
    e.end();
    e.backspace();
    assert!(e.text.ends_with("/clear"));
}
#[test]
fn terminal_controls_are_inert() {
    assert_eq!(
        clean("one\x1b]52;c;secret\x07two\x1b[2Jthree\x1b]0;title\x1b\\four\x00"),
        "onetwothreefour"
    );
    assert_eq!(clean("wide 界\ne\u{301}\ttext"), "wide 界\ne\u{301}\ttext");
}
#[test]
fn history_keeps_absolute_row_while_new_stream_rows_arrive() {
    let mut scroll = apex_cli::state::HistoryScroll::default();
    assert_eq!(scroll.start(100), 100);
    scroll.up(10);
    assert_eq!(scroll.start(100), 90);
    assert_eq!(scroll.start(105), 90);
    scroll.down(10);
    assert_eq!(scroll.start(105), 100);
    scroll.down(10);
    assert_eq!(scroll.start(105), 105);
    assert_eq!(scroll.start(110), 110);
}
#[test]
fn composer_wrap_and_caret_share_character_boundaries() {
    let (wrapped, position) = apex_cli::ui::editor_layout("hello long world", 10);
    assert_eq!(wrapped, "hello long\n world");
    assert_eq!(position, (6, 1));
    assert_eq!(apex_cli::ui::visual_position("hello long\n", 10), (0, 1));
    assert_eq!(apex_cli::ui::visual_position("\t", 2), (0, 2));
}
#[test]
fn switching_threads_retains_each_draft_and_questions_never_open_command_completion() {
    let mut state = AppState::default();
    state.select("a".into());
    state.editor.insert("unsent\ntext");
    state.select("b".into());
    assert!(state.editor.text.is_empty());
    state.select("a".into());
    assert_eq!(state.editor.text, "unsent\ntext");
    state.editor.take();
    state.answering = true;
    handle_event(&mut state, Event::Paste("/clear".into()));
    assert!(state.menu.is_none());
}
#[test]
fn welcome_logo_fits_each_terminal_size_and_keeps_threads_visible() {
    use ratatui::{backend::TestBackend, Terminal};
    let screen_text = |w: u16, h: u16| {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        let state = AppState::default();
        terminal
            .draw(|frame| {
                apex_cli::ui::draw(frame, &state, 0);
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            .map(|y| (0..w).map(|x| buffer[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    };
    // Full: pixel mark plus pixel wordmark, tagline beside the mark.
    let full = screen_text(140, 45);
    assert!(full.contains('▄') && full.contains('▀'));
    assert!(full.contains("Your agents. One workspace."));
    assert!(!full.contains("A P E X"));
    assert!(full.contains("Recent threads") && full.contains("/ for commands"));
    // Compact: small mark with the name as text.
    let compact = screen_text(80, 30);
    assert!(compact.contains("A P E X   D E C K"));
    assert!(compact.contains("Recent threads") && compact.contains("/ for commands"));
    // Short or narrow: one line, so the thread list is never pushed off screen.
    for (w, h) in [(80, 24), (40, 30)] {
        let small = screen_text(w, h);
        assert!(small.contains("◆ APEX DECK"));
        assert!(!small.contains('▀'));
        assert!(small.contains("Recent threads") && small.contains("/ for commands"));
    }
}
