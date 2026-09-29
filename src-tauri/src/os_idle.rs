/// Machine-wide input on supported desktops; other platforms use app activity.
#[tauri::command]
pub fn get_os_idle_seconds() -> Option<u64> {
    #[cfg(any(target_os = "macos", windows))]
    {
        user_idle::UserIdle::get_time()
            .ok()
            .map(|idle| idle.as_seconds())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}
