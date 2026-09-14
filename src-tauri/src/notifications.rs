//! Running-session desktop clicks. Policy and navigation remain in the host service.
//! Maintained OS backends own delivery; Linux uses their standard D-Bus interface.
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager};

const MAX_ACTIVE: usize = 128;
#[derive(Clone, Default)]
pub(crate) struct Notifications(Arc<Mutex<usize>>);

#[derive(Debug, PartialEq)]
enum Outcome {
    Activated,
    Closed,
    Failed(String),
}

type Callback = Box<dyn FnOnce(Outcome) + Send>;
struct Pending {
    count: Notifications,
    callback: Mutex<Option<Callback>>,
}
impl Notifications {
    fn reserve(&self, callback: Callback) -> Result<Arc<Pending>, String> {
        let mut count = self
            .0
            .lock()
            .map_err(|_| "Notification state unavailable")?;
        if *count >= MAX_ACTIVE {
            return Err("Too many active desktop notifications (maximum 128)".into());
        }
        *count += 1;
        Ok(Arc::new(Pending {
            count: self.clone(),
            callback: Mutex::new(Some(callback)),
        }))
    }
}
impl Pending {
    fn finish(&self, outcome: Outcome) {
        let callback = self.callback.lock().ok().and_then(|mut slot| slot.take());
        if let Some(callback) = callback {
            if let Ok(mut count) = self.count.0.lock() {
                *count -= 1;
            }
            callback(outcome);
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        // Covers backend failure/panic before a terminal response as well.
        self.finish(Outcome::Closed);
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct Response {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn respond(app: tauri::AppHandle, channel: Channel<Response>, id: String, outcome: Outcome) {
    let mut response = Response {
        id,
        kind: match outcome {
            Outcome::Activated => "activated",
            Outcome::Closed => "closed",
            Outcome::Failed(_) => "failed",
        },
        error: None,
    };
    if let Outcome::Failed(ref error) = outcome {
        response.error = Some(error.clone());
    }
    if outcome != Outcome::Activated {
        let _ = channel.send(response);
        return;
    }
    let fallback = (channel.clone(), response.clone());
    let main_app = app.clone();
    // Complete foregrounding on the main thread before delivering the exact click.
    // Even a focus failure must not silently discard the user's navigation intent.
    if let Err(error) = app.run_on_main_thread(move || {
        response.error = (|| {
            let window = main_app
                .get_webview_window("main")
                .ok_or("Buzz window unavailable")?;
            focus(&window)
        })()
        .err();
        let _ = channel.send(response);
    }) {
        let (channel, mut response) = fallback;
        response.error = Some(error.to_string());
        let _ = channel.send(response);
    }
}

fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::GtkWindowExt;
        // Tao queues show/unminimize but checks the old state before queuing
        // focus. GTK present performs the standard show/restore/raise operation
        // without that stale-state guard. This runs on Tauri's main thread.
        window.gtk_window().map_err(|e| e.to_string())?.present();
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }
}

fn validate(id: &str, title: &str, body: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(id).is_err() || title.len() > 4096 || body.len() > 4096 {
        return Err("Invalid desktop notification".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn notification_show(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Notifications>,
    id: String,
    title: String,
    body: String,
    on_event: Channel<Response>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Desktop notifications belong to the main window".into());
    }
    validate(&id, &title, &body)?;
    let responder = app.clone();
    let pending = state.reserve(Box::new(move |outcome| {
        respond(responder, on_event, id, outcome)
    }))?;
    // Admission returns promptly. Submission errors arrive on the pre-registered
    // channel; no platform's return value is claimed as proof of a visible banner.
    show(app, title, body, pending);
    Ok(())
}

#[cfg(target_os = "macos")]
fn show(app: tauri::AppHandle, title: String, body: String, pending: Arc<Pending>) {
    tauri::async_runtime::spawn_blocking(move || {
        // Preserve Tauri's development/installed identity convention. Initialize
        // once because this backend deliberately rejects subsequent set calls.
        static IDENTITY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
        let identity = IDENTITY.get_or_init(|| {
            mac_notification_sys::set_application(if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                &app.config().identifier
            })
            .map_err(|e| e.to_string())
        });
        if let Err(error) = identity {
            pending.finish(Outcome::Failed(error.clone()));
            return;
        }
        // notify-rust's buttonless wrapper omits wait_for_click. Use its existing
        // backend directly so body clicks retain their response registration.
        let result = mac_notification_sys::Notification::new()
            .title(&title)
            .message(&body)
            .wait_for_click(true)
            .asynchronous(false)
            .send();
        pending.finish(match result {
            Ok(mac_notification_sys::NotificationResponse::Click) => Outcome::Activated,
            Ok(_) => Outcome::Closed,
            Err(error) => Outcome::Failed(error.to_string()),
        });
    });
}

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
fn show(_app: tauri::AppHandle, title: String, body: String, pending: Arc<Pending>) {
    tauri::async_runtime::spawn(async move {
        linux::show(zbus::Connection::session().await, &title, &body, pending).await;
    });
}

#[cfg(target_os = "windows")]
fn show(app: tauri::AppHandle, title: String, body: String, pending: Arc<Pending>) {
    use tauri_winrt_notification::{Toast, ToastDismissalReason};
    tauri::async_runtime::spawn_blocking(move || {
        let activated = pending.clone();
        let dismissed = pending.clone();
        let result = (|| {
            let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
            let development = exe.parent().is_some_and(|dir| {
                dir.ends_with("target/debug") || dir.ends_with("target/release")
            });
            Toast::new(if development {
                Toast::POWERSHELL_APP_ID
            } else {
                &app.config().identifier
            })
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                activated.finish(Outcome::Activated);
                Ok(())
            })
            .on_dismissed(move |reason| {
                // Banner timeout is NOT notification-center dismissal. Keep
                // the click registration until actual activation/removal.
                if matches!(
                    reason,
                    Some(
                        ToastDismissalReason::UserCanceled
                            | ToastDismissalReason::ApplicationHidden
                    )
                ) {
                    dismissed.finish(Outcome::Closed);
                }
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            pending.finish(Outcome::Failed(error));
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn show(_app: tauri::AppHandle, _title: String, _body: String, pending: Arc<Pending>) {
    pending.finish(Outcome::Failed(
        "Desktop notifications unavailable on this platform".into(),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_terminal_response_releases_capacity_and_callback() {
        let state = Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        let pending = state
            .reserve(Box::new(move |event| output.lock().unwrap().push(event)))
            .unwrap();
        pending.finish(Outcome::Activated);
        pending.finish(Outcome::Closed);
        drop(pending);
        assert_eq!(*seen.lock().unwrap(), vec![Outcome::Activated]);
        assert_eq!(*state.0.lock().unwrap(), 0);
    }

    #[test]
    fn capacity_rejects_before_display_without_evicting_existing_callbacks() {
        let state = Notifications::default();
        let mut pending = Vec::new();
        for _ in 0..MAX_ACTIVE {
            pending.push(state.reserve(Box::new(|_| {})).unwrap());
        }
        assert!(state.reserve(Box::new(|_| {})).is_err());
        pending.pop().unwrap().finish(Outcome::Closed);
        assert!(state.reserve(Box::new(|_| {})).is_ok());
        drop(pending);
        assert_eq!(*state.0.lock().unwrap(), 0);
    }

    #[test]
    fn ingress_accepts_only_bounded_text_and_an_opaque_id() {
        assert!(validate(&uuid::Uuid::new_v4().to_string(), "Buzz", "Hello").is_ok());
        assert!(validate("not a presentation ID", "Buzz", "Hello").is_err());
        assert!(validate(&uuid::Uuid::new_v4().to_string(), "Buzz", &"x".repeat(4097)).is_err());
    }
}
