//! Deck's own Quit in the macOS app menu, so quitting asks first (see
//! apex-host's quit.rs).

/// The id of Deck's own Quit item in the macOS app menu.
pub const QUIT_MENU_ID: &str = "apex-deck-quit";

/// The default macOS menu with Deck's own Quit in place of the system one.
/// The system item calls `terminate:`, which ends the app without an exit
/// request, so nothing could ask first.
#[cfg(target_os = "macos")]
pub fn app_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(handle)?;
    // The first submenu is the app menu; the system Quit is its last item.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let count = app_menu.items()?.len();
        if count > 0 {
            app_menu.remove_at(count - 1)?;
        }
        let name = handle.package_info().name.clone();
        app_menu.append(&MenuItem::with_id(handle, QUIT_MENU_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
    }
    Ok(menu)
}
