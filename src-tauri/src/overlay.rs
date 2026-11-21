//! The small pill that floats above the taskbar while dictating: always on top, never takes focus
//! (so the text still lands in the app you were using), and lets clicks pass through.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "overlay";
const W: f64 = 236.0;
const H: f64 = 64.0;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#overlay".into()))
        .title("Morf dictation")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

/// Bottom centre of the monitor the mouse is on, just above the taskbar.
fn place(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let area = m.work_area();
        let w = (W * scale) as i32;
        let h = (H * scale) as i32;
        let x = area.position.x + (area.size.width as i32 - w) / 2;
        let y = area.position.y + area.size.height as i32 - h - (20.0 * scale) as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

pub fn show(app: &AppHandle) {
    if !crate::dictate::load_settings(app).overlay {
        return;
    }
    place(app);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

/// Shows the pill briefly so an error ("no model", "no microphone") is visible.
pub fn flash_error(app: &AppHandle) {
    show(app);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2600));
        hide(&app);
    });
}
