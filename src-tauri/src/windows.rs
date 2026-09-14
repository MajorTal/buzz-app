//! Detached tab windows. Rust owns which pages live in which window because it
//! owns window lifecycle and the profile directory. Every webview runs the full
//! app and renders only the tabs assigned to its label; pages assigned to no
//! detached window belong to `main`, which also keeps Home and Settings.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter as _, Manager as _};

pub(crate) const MAIN: &str = "main";
const EVENT: &str = "buzz:windows";
/// Sent to the destination window only, after the layout, naming the moved tab.
const ACTIVATE: &str = "buzz:windows:activate";
/// Sent to one window with `true` when a dragged tab hovers it and `false` when it leaves.
const DROP_TARGET: &str = "buzz:windows:drop-target";
const FILE: &str = "windows.json";
const MAX_WINDOWS: usize = 16;
const MAX_TABS: usize = 64;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TabWindow {
    pub label: String,
    pub tabs: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Layout {
    #[serde(default)]
    pub windows: Vec<TabWindow>,
}

/// Windows to create and close after a layout change is persisted.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Change {
    pub created: Option<String>,
    pub closed: Vec<String>,
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 80
        && segment.as_bytes()[0].is_ascii_alphanumeric()
        && segment.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'_' || c == b'-'
        })
}

/// Tabs are page contribution keys `<plugin id>/<page id>` or launcher panels
/// `panel:<plugin id>/<panel id>`; Home and Settings are neither.
fn valid_page_key(key: &str) -> Result<(), String> {
    let key = key.strip_prefix("panel:").unwrap_or(key);
    match key.split_once('/') {
        Some((plugin, page)) if valid_segment(plugin) && valid_segment(page) => Ok(()),
        _ => Err("Invalid page key".into()),
    }
}

fn valid_label(label: &str) -> bool {
    label
        .strip_prefix("tabs-")
        .is_some_and(|n| !n.is_empty() && n.len() <= 9 && n.bytes().all(|c| c.is_ascii_digit()))
}

impl Layout {
    fn sanitize(mut self) -> Self {
        self.windows.retain(|w| {
            valid_label(&w.label)
                && !w.tabs.is_empty()
                && w.tabs.len() <= MAX_TABS
                && w.tabs.iter().all(|t| valid_page_key(t).is_ok())
        });
        self.windows.truncate(MAX_WINDOWS);
        let mut seen = std::collections::HashSet::new();
        for window in &mut self.windows {
            window.tabs.retain(|tab| seen.insert(tab.clone()));
        }
        self.windows.retain(|w| !w.tabs.is_empty());
        self
    }
    fn next_label(&self) -> String {
        let next = self
            .windows
            .iter()
            .filter_map(|w| w.label.strip_prefix("tabs-")?.parse::<u32>().ok())
            .max()
            .map_or(1, |n| n + 1);
        format!("tabs-{next}")
    }
    fn detach(&mut self, page: &str) {
        for window in &mut self.windows {
            window.tabs.retain(|tab| tab != page);
        }
    }
    fn prune(&mut self) -> Vec<String> {
        let closed = self
            .windows
            .iter()
            .filter(|w| w.tabs.is_empty())
            .map(|w| w.label.clone())
            .collect();
        self.windows.retain(|w| !w.tabs.is_empty());
        closed
    }
    /// Move one page to `main`, `new`, or an open detached window.
    pub(crate) fn move_tab(&mut self, page: &str, destination: &str) -> Result<Change, String> {
        valid_page_key(page)?;
        let mut change = Change::default();
        match destination {
            MAIN => self.detach(page),
            "new" => {
                if self.windows.iter().any(|w| w.tabs == [page]) {
                    return Ok(change); // Already alone in its own window.
                }
                if self.windows.len() >= MAX_WINDOWS {
                    return Err("Too many windows are open".into());
                }
                self.detach(page);
                let label = self.next_label();
                self.windows.push(TabWindow {
                    label: label.clone(),
                    tabs: vec![page.to_owned()],
                });
                change.created = Some(label);
            }
            label => {
                let index = self
                    .windows
                    .iter()
                    .position(|w| w.label == label)
                    .ok_or("That window is no longer open")?;
                if self.windows[index].tabs.iter().any(|t| t == page) {
                    return Ok(change);
                }
                if self.windows[index].tabs.len() >= MAX_TABS {
                    return Err("That window has too many tabs".into());
                }
                self.detach(page);
                self.windows[index].tabs.push(page.to_owned());
            }
        }
        change.closed = self.prune();
        Ok(change)
    }
    /// A closed detached window returns its tabs to `main`.
    pub(crate) fn remove_window(&mut self, label: &str) -> bool {
        let before = self.windows.len();
        self.windows.retain(|w| w.label != label);
        self.windows.len() != before
    }
}

pub(crate) struct Windows {
    path: Option<PathBuf>,
    layout: Mutex<Layout>,
    /// The window currently under a dragged tab, told to show itself as the drop target.
    drop_target: Mutex<Option<String>>,
}

impl Windows {
    /// Without a profile directory the layout lives only for this process.
    pub(crate) fn open(profile: Option<&Path>) -> Self {
        let path = profile.map(|root| root.join(FILE));
        let layout = path
            .as_deref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Layout>(&bytes).ok())
            .unwrap_or_default()
            .sanitize();
        Self {
            path,
            layout: Mutex::new(layout),
            drop_target: Mutex::new(None),
        }
    }
    /// Point the drop-target highlight at `next`; only changes are broadcast.
    fn set_drop_target(&self, app: &tauri::AppHandle, next: Option<String>) {
        let Ok(mut current) = self.drop_target.lock() else {
            return;
        };
        if *current == next {
            return;
        }
        if let Some(previous) = current.take() {
            let _ = app.emit_to(&previous, DROP_TARGET, false);
        }
        if let Some(label) = &next {
            let _ = app.emit_to(label, DROP_TARGET, true);
        }
        *current = next;
    }
    pub(crate) fn layout(&self) -> Layout {
        self.layout.lock().map(|l| l.clone()).unwrap_or_default()
    }
    fn save(&self, layout: &Layout) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let parent = path.parent().ok_or("Invalid layout path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(layout).map_err(|e| e.to_string())?;
        let temp = parent.join(format!("{FILE}.{}.tmp", std::process::id()));
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    }
    fn update<T>(
        &self,
        operation: impl FnOnce(&mut Layout) -> Result<T, String>,
    ) -> Result<(T, Layout), String> {
        let mut guard = self
            .layout
            .lock()
            .map_err(|_| "Window layout is unavailable")?;
        let mut next = guard.clone();
        let result = operation(&mut next)?;
        if next != *guard {
            self.save(&next)?;
            *guard = next.clone();
        }
        Ok((result, next))
    }
}

fn create(app: &tauri::AppHandle, label: &str, at: Option<(f64, f64)>) -> tauri::Result<()> {
    let builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
            .title("Buzz Foundation")
            .inner_size(1000.0, 720.0)
            .min_inner_size(480.0, 400.0);
    // A dropped tab opens with the tab strip under the pointer, like a browser.
    let builder = match at {
        Some((x, y)) => builder.position((x - 160.0).max(0.0), (y - 28.0).max(0.0)),
        None => builder,
    };
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    builder.build().map(|_| ())
}

fn publish(app: &tauri::AppHandle, layout: &Layout) {
    if let Err(error) = app.emit(EVENT, layout) {
        eprintln!("Window layout broadcast failed: {error}");
    }
}

/// Recreate saved detached windows. Entries whose window cannot open return to main.
pub(crate) fn restore(app: &tauri::AppHandle) {
    let state = app.state::<Windows>();
    let saved = state.layout();
    let mut failed = Vec::new();
    for window in &saved.windows {
        if let Err(error) = create(app, &window.label, None) {
            eprintln!("Could not restore window {}: {error}", window.label);
            failed.push(window.label.clone());
        }
    }
    if failed.is_empty() {
        return;
    }
    match state.update(|layout| {
        for label in &failed {
            layout.remove_window(label);
        }
        Ok(())
    }) {
        Ok((_, layout)) => publish(app, &layout),
        Err(error) => eprintln!("Window layout save failed: {error}"),
    }
}

/// Closing main quits the whole app; closing a detached window returns its tabs.
pub(crate) fn window_closing(app: &tauri::AppHandle, label: &str) {
    if label == MAIN {
        app.exit(0);
        return;
    }
    let state = app.state::<Windows>();
    match state.update(|layout| Ok(layout.remove_window(label))) {
        Ok((true, layout)) => publish(app, &layout),
        Ok((false, _)) => {}
        Err(error) => eprintln!("Window layout save failed: {error}"),
    }
}

#[tauri::command]
pub(crate) fn windows_layout(state: tauri::State<'_, Windows>) -> Layout {
    state.layout()
}

fn apply_move(
    app: &tauri::AppHandle,
    state: &Windows,
    page_key: &str,
    destination: &str,
    at: Option<(f64, f64)>,
) -> Result<Layout, String> {
    let (change, layout) = state.update(|layout| layout.move_tab(page_key, destination))?;
    if let Some(label) = &change.created {
        if let Err(error) = create(app, label, at) {
            let (_, layout) = state.update(|layout| {
                layout.remove_window(label);
                Ok(())
            })?;
            publish(app, &layout);
            return Err(format!("Could not open a window: {error}"));
        }
    }
    for label in &change.closed {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    publish(app, &layout);
    // Like a browser, the moved tab becomes the active tab of a focused window.
    let target = change.created.as_deref().unwrap_or(destination);
    if let Some(window) = app.get_webview_window(target) {
        let _ = window.set_focus();
        if let Err(error) = app.emit_to(target, ACTIVATE, page_key) {
            eprintln!("Tab activation failed: {error}");
        }
    }
    Ok(layout)
}

#[tauri::command]
pub(crate) async fn windows_move_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, Windows>,
    page_key: String,
    destination: String,
) -> Result<Layout, String> {
    apply_move(&app, &state, &page_key, &destination, None)
}

/// The pill that follows the pointer while a tab is dragged. A DOM ghost would
/// vanish at the source window's edge; this always-on-top window is reused
/// across drags and never receives cursor events or focus.
const GHOST: &str = "drag-ghost";
const GHOST_OFFSET: (f64, f64) = (14.0, 14.0);

fn ghost(app: &tauri::AppHandle, title: &str) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window(GHOST) {
        // The nonce makes every show a hashchange, so the ghost re-reads the
        // title and the appearance even when the same tab is dragged again.
        static SHOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SHOWN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        window.eval(format!(
            "location.hash = {}",
            serde_json::to_string(&format!("#title={}&n={nonce}", encode(title)))
                .unwrap_or_default()
        ))?;
        return Ok(window);
    }
    let url = format!("drag-ghost.html?title={}", encode(title));
    let builder = tauri::WebviewWindowBuilder::new(app, GHOST, tauri::WebviewUrl::App(url.into()))
        .title("Dragging tab")
        .inner_size(180.0, 44.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .transparent(true)
        .shadow(false);
    let window = builder.build()?;
    window.set_ignore_cursor_events(true)?;
    Ok(window)
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn ghost_position(x: f64, y: f64) -> tauri::LogicalPosition<f64> {
    tauri::LogicalPosition::new(x + GHOST_OFFSET.0, y + GHOST_OFFSET.1)
}

fn hide_ghost(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(GHOST) {
        let _ = window.hide();
    }
}

#[tauri::command]
pub(crate) async fn windows_drag_begin(
    app: tauri::AppHandle,
    title: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if title.chars().count() > 120 || !x.is_finite() || !y.is_finite() {
        return Err("Invalid drag".into());
    }
    let window = ghost(&app, title.trim()).map_err(|e| e.to_string())?;
    window
        .set_position(ghost_position(x, y))
        .and_then(|()| window.show())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn windows_drag_move(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Windows>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid drag".into());
    }
    state.set_drop_target(&app, window_at(&app, window.label(), x, y));
    if let Some(ghost) = app.get_webview_window(GHOST) {
        ghost
            .set_position(ghost_position(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn windows_drag_end(
    app: tauri::AppHandle,
    state: tauri::State<'_, Windows>,
) -> Result<(), String> {
    state.set_drop_target(&app, None);
    hide_ghost(&app);
    Ok(())
}

/// Which Buzz window, other than `source` and the drag ghost, is under a logical screen point.
fn window_at(app: &tauri::AppHandle, source: &str, x: f64, y: f64) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label != source && label != GHOST)
        .find(|(_, window)| {
            let Ok(scale) = window.scale_factor() else {
                return false;
            };
            let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
                return false;
            };
            let position = position.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            x >= position.x
                && y >= position.y
                && x < position.x + size.width
                && y < position.y + size.height
        })
        .map(|(label, _)| label)
}

/// A tab dragged out of its strip and released at a screen point joins the
/// window under the pointer, or opens a new window there.
#[tauri::command]
pub(crate) async fn windows_drop_tab(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Windows>,
    page_key: String,
    x: f64,
    y: f64,
) -> Result<Layout, String> {
    state.set_drop_target(&app, None);
    hide_ghost(&app);
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid drop point".into());
    }
    let destination = window_at(&app, window.label(), x, y).unwrap_or_else(|| "new".into());
    apply_move(&app, &state, &page_key, &destination, Some((x, y)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "buzz-windows-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn new_window_moves_a_page_out_of_main_and_back() {
        let mut layout = Layout::default();
        let change = layout.move_tab("buzz.channels/channels", "new").unwrap();
        assert_eq!(change.created.as_deref(), Some("tabs-1"));
        assert_eq!(layout.windows[0].tabs, ["buzz.channels/channels"]);
        // Repeating the request is idempotent rather than creating an empty second window.
        let again = layout.move_tab("buzz.channels/channels", "new").unwrap();
        assert_eq!(again, Change::default());
        let change = layout.move_tab("buzz.channels/channels", MAIN).unwrap();
        assert_eq!(change.closed, ["tabs-1"]);
        assert!(layout.windows.is_empty());
    }

    #[test]
    fn a_page_lives_in_exactly_one_window() {
        let mut layout = Layout::default();
        layout.move_tab("buzz.channels/channels", "new").unwrap();
        let change = layout.move_tab("buzz.agents/agents", "new").unwrap();
        assert_eq!(change.created.as_deref(), Some("tabs-2"));
        let change = layout.move_tab("buzz.agents/agents", "tabs-1").unwrap();
        assert_eq!(change.closed, ["tabs-2"]);
        assert_eq!(layout.windows.len(), 1);
        assert_eq!(
            layout.windows[0].tabs,
            ["buzz.channels/channels", "buzz.agents/agents"]
        );
        // Labels are never reused while the layout remembers a higher number.
        let change = layout.move_tab("buzz.projects/projects", "new").unwrap();
        assert_eq!(change.created.as_deref(), Some("tabs-2"));
    }

    #[test]
    fn rejects_invalid_pages_and_unknown_destinations() {
        let mut layout = Layout::default();
        for key in [
            "home",
            "settings",
            "",
            "Buzz/Page",
            "a/b/c",
            "plugin/",
            "/page",
            "panel:",
            "panel:home",
            "page:buzz.a/a",
        ] {
            assert!(layout.move_tab(key, "new").is_err(), "{key}");
        }
        assert!(layout
            .move_tab("panel:buzz.bestie/companion", "new")
            .is_ok());
        assert!(layout.move_tab("buzz.channels/channels", "tabs-9").is_err());
        assert!(layout.move_tab("buzz.channels/channels", "other").is_err());
        assert_eq!(layout.windows.len(), 1);
    }

    #[test]
    fn closing_a_detached_window_returns_its_tabs_to_main() {
        let mut layout = Layout::default();
        layout.move_tab("buzz.channels/channels", "new").unwrap();
        assert!(layout.remove_window("tabs-1"));
        assert!(!layout.remove_window("tabs-1"));
        assert!(layout.windows.is_empty());
    }

    #[test]
    fn persists_and_restores_a_sanitized_layout() {
        let dir = temp_dir("persist");
        let windows = Windows::open(Some(&dir));
        windows
            .update(|layout| layout.move_tab("buzz.channels/channels", "new"))
            .unwrap();
        windows
            .update(|layout| layout.move_tab("buzz.agents/agents", "tabs-1"))
            .unwrap();
        let reopened = Windows::open(Some(&dir));
        assert_eq!(reopened.layout(), windows.layout());
        fs::write(
            dir.join(FILE),
            r#"{"windows":[{"label":"tabs-3","tabs":["buzz.a/a","buzz.a/a"]},{"label":"bad","tabs":["buzz.b/b"]},{"label":"tabs-4","tabs":[]},{"label":"tabs-5","tabs":["buzz.a/a","home"]}]}"#,
        )
        .unwrap();
        let repaired = Windows::open(Some(&dir)).layout();
        assert_eq!(
            repaired,
            Layout {
                windows: vec![TabWindow {
                    label: "tabs-3".into(),
                    tabs: vec!["buzz.a/a".into()],
                }],
            }
        );
        fs::write(dir.join(FILE), "not json").unwrap();
        assert_eq!(Windows::open(Some(&dir)).layout(), Layout::default());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn without_a_profile_the_layout_is_in_memory_only() {
        let windows = Windows::open(None);
        let (change, layout) = windows
            .update(|layout| layout.move_tab("buzz.channels/channels", "new"))
            .unwrap();
        assert_eq!(change.created.as_deref(), Some("tabs-1"));
        assert_eq!(windows.layout(), layout);
    }
}
