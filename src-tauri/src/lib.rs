pub mod commands;
pub mod db;
pub mod error;
pub mod model;
pub mod validate;

use tauri::Manager;

/// Filename inside the platform app-data directory. On macOS this resolves to
/// `~/Library/Application Support/com.nicotejera.timey/timey.db`.
const DATABASE_FILE: &str = "timey.db";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join(DATABASE_FILE);

            // Blocking here is deliberate: the window should not appear until
            // migrations have succeeded, so the UI never sees a half-built schema.
            let pool = tauri::async_runtime::block_on(db::connect(&path))
                .map_err(|err| format!("failed to open {}: {err}", path.display()))?;

            app.manage(pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
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
