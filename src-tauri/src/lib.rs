pub mod commands;
pub mod db;
pub mod error;
pub mod model;
pub mod validate;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Filename inside the platform app-data directory. On macOS this resolves to
/// `~/Library/Application Support/com.nicotejera.timey/timey.db`.
const DATABASE_FILE: &str = "timey.db";

/// Emitted to the frontend when Settings is chosen from the menu.
const OPEN_SETTINGS: &str = "open-settings";

/// A single application menu.
///
/// macOS always shows an application menu, so File, View, Window and Help are
/// gone but this one stays. Settings lives here under the conventional Cmd+,
/// rather than in the window, and the standard edit items sit alongside it: their
/// keyboard equivalents are matched by key, not by which menu holds them, so
/// Cmd+C/V/X/A keep working in text fields without a visible Edit menu.
fn build_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = MenuItem::with_id(
        handle,
        OPEN_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let app_menu = Submenu::with_items(
        handle,
        "timey",
        true,
        &[
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == OPEN_SETTINGS {
                // Fails only if no window is listening yet, which leaves
                // nothing to navigate anyway.
                let _ = app.emit(OPEN_SETTINGS, ());
            }
        })
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Desktop-only: there is no updater on mobile targets.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            let path = app.path().app_data_dir()?.join(DATABASE_FILE);

            // Blocking here is deliberate: the window should not appear until
            // migrations have succeeded, so the UI never sees a half-built schema.
            let pool = tauri::async_runtime::block_on(db::connect(&path))
                .map_err(|err| format!("failed to open {}: {err}", path.display()))?;

            app.manage(pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::clients_list,
            commands::client_create,
            commands::client_rename,
            commands::client_set_archived,
            commands::client_delete,
            commands::contacts_list,
            commands::contact_create,
            commands::contact_update,
            commands::contact_delete,
            commands::projects_list,
            commands::project_create,
            commands::project_update,
            commands::project_set_archived,
            commands::project_delete,
            commands::entries_list,
            commands::entry_create,
            commands::entry_update,
            commands::entry_delete,
            commands::entries_daily_totals,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
