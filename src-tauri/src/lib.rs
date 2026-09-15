mod notifications;
mod terminal;
use notifications::{notification_show, Notifications};
use tauri::Manager as _;
use terminal::{
    terminal_close, terminal_close_owner, terminal_create_owner, terminal_read, terminal_resize,
    terminal_spawn, terminal_write, Terminals,
};

use buzzodz_plugins::{
    imports::{prepare_folder, prepare_git, PreparedImport, Preview},
    Catalog, InstallationResult, Manager,
};
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Default)]
struct Imports(Arc<Mutex<Option<PreparedImport>>>);

#[derive(Debug, PartialEq, Eq)]
enum TitleBarDoubleClickAction {
    Maximize,
    Minimize,
    None,
}

fn title_bar_double_click_action(preference: Option<&str>) -> TitleBarDoubleClickAction {
    match preference {
        Some("Maximize" | "Zoom" | "Fill") => TitleBarDoubleClickAction::Maximize,
        Some("Minimize") => TitleBarDoubleClickAction::Minimize,
        _ => TitleBarDoubleClickAction::None,
    }
}

#[tauri::command]
fn title_bar_double_click(window: tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSUserDefaults};

        let preference = NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleActionOnDoubleClick"))
            .map(|value| value.to_string());
        match title_bar_double_click_action(preference.as_deref()) {
            TitleBarDoubleClickAction::Maximize => {
                if window.is_maximized().map_err(|error| error.to_string())? {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                .map_err(|error| error.to_string())?;
            }
            TitleBarDoubleClickAction::Minimize => {
                window.minimize().map_err(|error| error.to_string())?;
            }
            TitleBarDoubleClickAction::None => {}
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(())
}

async fn prepare_import(
    imports: Imports,
    operation: impl FnOnce() -> Result<Option<PreparedImport>, String> + Send + 'static,
) -> Result<Option<Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        *pending = None;
        *pending = operation()?;
        Ok(pending.as_ref().map(|p| p.preview.clone()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_import_folder(
    app: tauri::AppHandle,
    imports: tauri::State<'_, Imports>,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        app.dialog()
            .file()
            .set_title("Choose a plugin folder")
            .blocking_pick_folder()
            .map(|folder| prepare_folder(&folder.into_path().map_err(|e| e.to_string())?))
            .transpose()
    })
    .await
}
#[tauri::command]
async fn plugin_import_git(
    imports: tauri::State<'_, Imports>,
    repository: String,
    reference: String,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        prepare_git(&repository, &reference).map(Some)
    })
    .await
}
#[tauri::command]
async fn plugin_import_discard(
    imports: tauri::State<'_, Imports>,
    token: String,
) -> Result<(), String> {
    let mut pending = imports
        .0
        .try_lock()
        .map_err(|_| "Another import is in progress")?;
    if pending.as_ref().is_some_and(|p| p.preview.token == token) {
        *pending = None;
    }
    Ok(())
}
#[tauri::command]
async fn plugin_import_install(
    manager: tauri::State<'_, PluginManager>,
    imports: tauri::State<'_, Imports>,
    token: String,
    path: String,
) -> Result<InstallationResult, String> {
    let imports = imports.inner().clone();
    with_manager(manager, move |m| {
        let pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        pending
            .as_ref()
            .ok_or("This import preview expired. Choose the source again.")?
            .install(&m, &token, &path)
            .map(|catalog| ready(&m, catalog))
    })
    .await
}

fn ready(manager: &Manager, catalog: Catalog) -> InstallationResult {
    InstallationResult::Ready {
        catalog,
        external_plugins_paused: manager.external_plugins_paused(),
    }
}

// Invalid environment configuration must not prevent the recovery shell from opening.
struct PluginManager(Result<Manager, String>);
async fn with_manager<T: Send + 'static>(
    state: tauri::State<'_, PluginManager>,
    operation: impl FnOnce(Manager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = state.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || operation(manager))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_catalog(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| {
        Ok(match m.catalog() {
            Ok(catalog) => ready(&m, catalog),
            Err(reason) => InstallationResult::Recovery {
                reason,
                can_reset: true,
            },
        })
    })
    .await
}
#[tauri::command]
async fn plugin_change(
    manager: tauri::State<'_, PluginManager>,
    action: String,
    id: String,
) -> Result<InstallationResult, String> {
    with_manager(manager, move |m| {
        m.change(&action, &id).map(|catalog| ready(&m, catalog))
    })
    .await
}
#[tauri::command]
async fn plugin_module(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<String, String> {
    with_manager(manager, move |m| m.module(&id, &revision)).await
}
#[tauri::command]
async fn plugin_recover(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| m.recover().map(|catalog| ready(&m, catalog))).await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Imports::default())
        .manage(Terminals::default())
        .manage(Notifications::default())
        .manage(PluginManager(Manager::from_env()))
        .invoke_handler(tauri::generate_handler![
            title_bar_double_click,
            notification_show,
            terminal_create_owner,
            terminal_spawn,
            terminal_read,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_close_owner,
            plugin_import_folder,
            plugin_import_git,
            plugin_import_install,
            plugin_import_discard,
            plugin_catalog,
            plugin_change,
            plugin_module,
            plugin_recover
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Buzz Foundation")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Err(error) = app.state::<Terminals>().shutdown() {
                    eprintln!("Terminal shutdown failed: {error}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{title_bar_double_click_action, TitleBarDoubleClickAction};

    #[test]
    fn title_bar_double_click_preferences_map_to_native_actions() {
        assert_eq!(
            title_bar_double_click_action(Some("Maximize")),
            TitleBarDoubleClickAction::Maximize
        );
        assert_eq!(
            title_bar_double_click_action(Some("Fill")),
            TitleBarDoubleClickAction::Maximize
        );
        assert_eq!(
            title_bar_double_click_action(Some("Minimize")),
            TitleBarDoubleClickAction::Minimize
        );
        assert_eq!(
            title_bar_double_click_action(Some("None")),
            TitleBarDoubleClickAction::None
        );
        assert_eq!(
            title_bar_double_click_action(None),
            TitleBarDoubleClickAction::None
        );
    }
}
