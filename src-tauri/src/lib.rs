pub mod commands;
pub mod db;
pub mod error;
pub mod mail;
pub mod model;
pub mod validate;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, Rect, WebviewWindow};

/// Filename inside the platform app-data directory. On macOS this resolves to
/// `~/Library/Application Support/com.nicotejera.timey/timey.db`.
const DATABASE_FILE: &str = "timey.db";

/// Emitted to the frontend when Settings is chosen.
const OPEN_SETTINGS: &str = "open-settings";
const QUIT: &str = "quit";

/// The single window, which behaves as a popover rather than a normal window.
const POPOVER: &str = "main";

/// Gap in physical pixels between the menu bar icon and the popover.
const TRAY_GAP: f64 = 6.0;
/// Keep this much of the screen edge clear when the icon sits near a corner.
const EDGE_MARGIN: f64 = 8.0;

/// The application menu.
///
/// As a menu bar accessory the app shows no menu bar at all, so this exists for
/// its keyboard equivalents: Cmd+C/V/X/A are matched by key, and without the
/// items registered they stop working inside text fields.
fn build_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        handle,
        "Timey",
        true,
        &[
            &MenuItem::with_id(handle, OPEN_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu])
}

/// The right-click menu on the menu bar icon. With no Dock icon and no visible
/// menu bar, this is the only way to quit.
fn tray_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    Menu::with_items(
        handle,
        &[
            &MenuItem::with_id(handle, OPEN_SETTINGS, "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, QUIT, "Quit Timey", true, None::<&str>)?,
        ],
    )
}

/// Places the popover centred under the menu bar icon, kept on screen.
fn position_under_tray<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    rect: Rect,
) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let icon_position = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let size = window.outer_size()?;

    let mut x = icon_position.x + icon_size.width / 2.0 - f64::from(size.width) / 2.0;
    let y = icon_position.y + icon_size.height + TRAY_GAP;

    // An icon near the right edge would otherwise push the popover off screen.
    if let Some(monitor) = window.current_monitor()? {
        let origin = monitor.position();
        let bounds = monitor.size();
        let left = f64::from(origin.x) + EDGE_MARGIN;
        let right = f64::from(origin.x + bounds.width as i32) - f64::from(size.width) - EDGE_MARGIN;
        x = x.clamp(left, right.max(left));
    }

    window.set_position(PhysicalPosition::new(x, y))
}

fn toggle_popover<R: tauri::Runtime>(window: &WebviewWindow<R>, rect: Rect) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let _ = position_under_tray(window, rect);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_SETTINGS => {
                if let Some(window) = app.get_webview_window(POPOVER) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Fails only if nothing is listening yet, which leaves nothing
                // to navigate anyway.
                let _ = app.emit(OPEN_SETTINGS, ());
            }
            QUIT => app.exit(0),
            _ => {}
        })
        // Deliberately no hide-on-blur. Any native dialog the app opens — the
        // folder picker in particular — takes focus away from the popover, which
        // would dismiss it and leave the dialog orphaned. Dismissal is explicit:
        // the close button, Escape, or clicking the menu bar icon again.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // No Dock icon and no menu bar: this is a menu bar accessory.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_dialog::init())?;
            }

            let path = app.path().app_data_dir()?.join(DATABASE_FILE);

            // Blocking here is deliberate: the popover should not open until
            // migrations have succeeded, so the UI never sees a half-built schema.
            let pool = tauri::async_runtime::block_on(db::connect(&path))
                .map_err(|err| format!("failed to open {}: {err}", path.display()))?;

            app.manage(pool);

            let menu = tray_menu(app.handle())?;
            TrayIconBuilder::with_id("timey")
                .icon(tauri::include_image!("./icons/tray-clock.png"))
                // Template images are recoloured by macOS to suit the menu bar.
                .icon_as_template(true)
                .menu(&menu)
                // Left click toggles the popover; the menu is right-click only.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window(POPOVER) {
                            toggle_popover(&window, rect);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::clients_list,
            commands::client_create,
            commands::client_update,
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
            commands::settings_all,
            commands::settings_set,
            commands::invoice_candidates,
            commands::invoice_prepare,
            commands::invoice_issue,
            commands::invoice_email,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
