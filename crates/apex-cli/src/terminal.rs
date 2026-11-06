use crate::{
    commands::catalog,
    controller::choice,
    state::mention,
    state::{Action, AppState, Menu},
};
use crossterm::{
    cursor::Show,
    event::{Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use std::io;
pub struct Guard;
impl Guard {
    pub fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let guard = Self;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            crossterm::event::EnableBracketedPaste,
            crossterm::event::EnableMouseCapture
        )?;
        execute!(
            io::stdout(),
            crossterm::event::PushKeyboardEnhancementFlags(
                crossterm::event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
            )
        )?;
        Ok(guard)
    }
    pub fn restore() {
        let _ = execute!(
            io::stdout(),
            crossterm::event::PopKeyboardEnhancementFlags,
            crossterm::event::DisableMouseCapture,
            crossterm::event::DisableBracketedPaste,
            Show,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        Self::restore();
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum Intent {
    None,
    Quit,
    Submit,
    Activate,
    Stop,
    Welcome,
    Threads,
    Requests,
    WelcomeUp,
    WelcomeDown,
    WelcomeOpen,
    Panel(crate::settings::PanelIntent),
}
pub fn handle_event(s: &mut AppState, event: Event) -> Intent {
    match event {
        Event::Paste(text) => {
            s.menu = None;
            s.editor.insert(&text);
            completion(s);
            Intent::None
        }
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                return Intent::Quit;
            }
            // ⇧Tab comes before the / and @ menus. Some terminals send Tab+Shift.
            if key.code == KeyCode::BackTab
                || (key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT))
            {
                s.menu = None;
                crate::settings::toggle(s);
                return Intent::Panel(crate::settings::PanelIntent::None);
            }
            // While open, the panel owns arrows, Tab, Enter and Esc (Esc never
            // stops agents here). A menu opened from it (the model list) is on top.
            if s.settings.is_some() {
                if s.menu.is_some() {
                    // Esc in the model list goes back to the panel, never stops work.
                    if key.code == KeyCode::Esc {
                        s.menu = None;
                        return Intent::Panel(crate::settings::PanelIntent::None);
                    }
                } else if let Some(intent) = crate::settings::handle_key(s, key.code) {
                    return Intent::Panel(intent);
                }
            }
            if (key.code == KeyCode::Enter
                && key
                    .modifiers
                    .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT))
                || (key.code == KeyCode::Char('j') && key.modifiers.contains(KeyModifiers::CONTROL))
            {
                s.menu = None;
                s.editor.insert("\n");
                return Intent::None;
            }
            match key.code {
                KeyCode::Esc => {
                    s.menu = None;
                    return Intent::Stop;
                }
                KeyCode::F(1) => return Intent::Welcome,
                KeyCode::F(2) => return Intent::Requests,
                KeyCode::F(3) => return Intent::Threads,
                KeyCode::F(4) => {
                    s.view = 3;
                    return Intent::None;
                }
                KeyCode::PageUp => {
                    s.history.borrow_mut().up(10);
                    return Intent::None;
                }
                KeyCode::PageDown => {
                    s.history.borrow_mut().down(10);
                    return Intent::None;
                }
                _ => {}
            }
            if let Some(menu) = s.menu.as_mut() {
                match key.code {
                    KeyCode::Up => {
                        menu.selected = if menu.selected == 0 {
                            menu.choices.len().saturating_sub(1)
                        } else {
                            menu.selected - 1
                        };
                        return Intent::None;
                    }
                    KeyCode::Down => {
                        menu.selected = (menu.selected + 1) % menu.choices.len().max(1);
                        return Intent::None;
                    }
                    KeyCode::Enter | KeyCode::Tab => return Intent::Activate,
                    _ => {
                        if !menu.completion {
                            s.menu = None;
                        }
                    }
                }
            } else if s.view == 0 && s.editor.text.is_empty() {
                match key.code {
                    KeyCode::Up => return Intent::WelcomeUp,
                    KeyCode::Down => return Intent::WelcomeDown,
                    KeyCode::Enter => return Intent::WelcomeOpen,
                    _ => {}
                }
            }
            match key.code {
                KeyCode::Enter => {
                    return if s.editor.text.trim().is_empty() {
                        Intent::None
                    } else {
                        Intent::Submit
                    }
                }
                KeyCode::Left => s.editor.left(),
                KeyCode::Right => s.editor.right(),
                KeyCode::Home => s.editor.home(),
                KeyCode::End => s.editor.end(),
                KeyCode::Backspace => s.editor.backspace(),
                KeyCode::Delete => s.editor.delete(),
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    s.editor.insert(&c.to_string())
                }
                _ => return Intent::None,
            }
            completion(s);
            Intent::None
        }
        _ => Intent::None,
    }
}
pub fn completion(s: &mut AppState) {
    if s.answering || s.agent_wizard.is_some() || s.workspace_prompt {
        s.menu = None;
        return;
    }
    let before = &s.editor.text[..s.editor.cursor];
    let command = before
        .strip_prefix('/')
        .filter(|_| !before.starts_with("//") && !before.contains('\n'));
    if let Some(query) = command {
        let choices = catalog()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.key.starts_with(&query.to_lowercase()))
            .map(|r| {
                let action = if r.argument_mode == "none"
                    || matches!(
                        r.key.as_str(),
                        "threads" | "add" | "remove" | "model" | "access" | "help" | "new" | "login" | "agents create" | "agents saved" | "agents edit" | "agents import"
                    ) {
                    Action::Submit(format!("/{}", r.key))
                } else {
                    Action::Insert(format!("/{} ", r.key))
                };
                choice(r.label, r.detail, action)
            })
            .collect::<Vec<_>>();
        s.menu = if choices.is_empty() {
            None
        } else {
            Some(Menu {
                title: "Commands".into(),
                choices,
                selected: 0,
                completion: true,
            })
        };
        return;
    }
    let word = before.rsplit(char::is_whitespace).next().unwrap_or("");
    if let Some(query) = word.strip_prefix('@') {
        let mut choices = s
            .members()
            .iter()
            .map(|p| {
                (
                    format!("@{}", mention(p)),
                    p["display_name"].as_str().unwrap_or("Agent").to_string(),
                )
            })
            .collect::<Vec<_>>();
        choices.push(("@all".into(), "Everyone answers".into()));
        let choices = choices
            .into_iter()
            .filter(|(label, _)| label[1..].starts_with(&query.to_lowercase()))
            .map(|(label, detail)| {
                choice(label.clone(), detail, Action::Insert(format!("{label} ")))
            })
            .collect::<Vec<_>>();
        s.menu = if choices.is_empty() {
            None
        } else {
            Some(Menu {
                title: "Pick an agent".into(),
                choices,
                selected: 0,
                completion: true,
            })
        };
        return;
    }
    s.menu = None;
}
pub fn insert_completion(s: &mut AppState, text: &str) {
    if text.starts_with('@') {
        let before = &s.editor.text[..s.editor.cursor];
        let start = before
            .rfind(char::is_whitespace)
            .map(|n| n + before[n..].chars().next().unwrap().len_utf8())
            .unwrap_or(0);
        s.editor.text.replace_range(start..s.editor.cursor, text);
        s.editor.cursor = start + text.len();
    } else {
        s.editor.text = text.into();
        s.editor.end();
    }
    s.menu = None;
}
