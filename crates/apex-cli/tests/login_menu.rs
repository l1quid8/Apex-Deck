use apex_cli::controller::login_menu;
use apex_cli::provider_setup::Store;
use apex_cli::state::Action;
use std::path::PathBuf;

fn labels(store: Store, provider: &str) -> (String, Vec<(String, String)>) {
    let menu = login_menu(provider, store).menu.unwrap();
    let rows = menu.choices.into_iter().map(|c| {
        let action = match c.action { Action::Setup(s) => s, Action::Dismiss => "dismiss".into(), _ => "other".into() };
        (c.label, action)
    }).collect();
    (menu.title, rows)
}

#[test]
fn mac_login_menu_is_unchanged() {
    let (title, rows) = labels(Store::Person, "codex");
    assert_eq!(title, "Attach codex");
    assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), ["login codex reuse", "login codex browser", "login codex device", "dismiss"]);
}

#[test]
fn linux_login_menu_signs_deck_in_and_leads_codex_with_the_device_code() {
    let deck = || Store::Deck(PathBuf::from("/data/logins/x"));
    let (title, rows) = labels(deck(), "codex");
    assert_eq!(title, "Sign Deck in to codex");
    assert_eq!(rows[0].0, "Use Deck's existing sign-in");
    assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), ["login codex reuse", "login codex device", "login codex browser", "dismiss"]);
    let (_, rows) = labels(deck(), "claude");
    assert_eq!(rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(), ["login claude reuse", "login claude subscription", "dismiss"]);
}

#[test]
fn help_names_the_platform_rule() {
    #[cfg(target_os = "linux")]
    assert!(apex_cli::args::HELP.contains("agent jail check") && !apex_cli::args::HELP.contains("authority installer"));
    #[cfg(target_os = "macos")]
    assert!(apex_cli::args::HELP.contains("signed CLI authority installer"));
}
