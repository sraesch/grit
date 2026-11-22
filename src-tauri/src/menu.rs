//! The macOS app menu: Tauri's default menu plus "Settings…" and the File menu's entries for
//! opening, cloning and creating repositories, which the frontend carries out.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

/// Menu item ids and the event each one emits to the frontend.
const EVENTS: [(&str, &str); 4] = [
    ("settings", "open-settings"),
    ("open-repository", "open-repository"),
    ("clone-repository", "clone-repository"),
    ("new-repository", "new-repository"),
];

/// The default menu with "Settings…" (⌘,) after "About grit", where macOS apps keep it, and
/// "New Repository…", "Open…" and "Clone…" at the top of the File menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let items = menu.items()?;
    if let Some(MenuItemKind::Submenu(app_menu)) = items.first() {
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        // The app menu starts with "About grit" and a separator.
        app_menu.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
    }
    let file = items.iter().find_map(|item| match item {
        MenuItemKind::Submenu(sub) if sub.text().is_ok_and(|t| t == "File") => Some(sub),
        _ => None,
    });
    if let Some(file) = file {
        let new = MenuItem::with_id(app, "new-repository", "New Repository…", true, None::<&str>)?;
        let open = MenuItem::with_id(app, "open-repository", "Open…", true, Some("CmdOrCtrl+O"))?;
        let clone = MenuItem::with_id(app, "clone-repository", "Clone…", true, None::<&str>)?;
        file.insert_items(&[&new, &open, &clone, &PredefinedMenuItem::separator(app)?], 0)?;
    }
    Ok(menu)
}

/// Tells the frontend which menu item was chosen.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if let Some((_, name)) = EVENTS.iter().find(|(id, _)| event.id() == *id) {
        let _ = app.emit(name, ());
    }
}
