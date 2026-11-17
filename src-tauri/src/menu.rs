//! The macOS app menu: Tauri's default menu plus a "Settings…" entry that opens the in-app settings.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const SETTINGS_ID: &str = "settings";

/// The default menu with "Settings…" (⌘,) after "About grit", where macOS apps keep it.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        let settings = MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
        // The app menu starts with "About grit" and a separator.
        app_menu.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
    }
    Ok(menu)
}

/// Tells the frontend to open the settings dialog when "Settings…" is chosen.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == SETTINGS_ID {
        let _ = app.emit("open-settings", ());
    }
}
