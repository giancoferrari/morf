//! Pick a colour from anywhere on screen. The webview's EyeDropper doesn't work inside WebView2,
//! so Morf does what most colour pickers do: it steps out of the way, takes a still of every
//! monitor, and covers each one with a borderless window showing that still. The window shows a
//! loupe under the cursor; a click picks the pixel, Esc cancels.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const PREFIX: &str = "picker-";

/// The stills, one per monitor, held while the picker is open.
#[derive(Default)]
pub struct Picker {
    shots: Mutex<Vec<xcap::image::RgbaImage>>,
    /// The window under the cursor, which takes the keyboard.
    focus: Mutex<Option<usize>>,
}

#[derive(Serialize, Clone)]
struct Picked {
    hex: Option<String>,
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hides Morf, captures every monitor and opens one picker window per monitor.
pub async fn open(app: AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    // Let the window's close animation finish so it isn't in the still.
    tokio::time::sleep(Duration::from_millis(220)).await;

    let captured = tauri::async_runtime::spawn_blocking(|| -> Result<Vec<(i32, i32, u32, u32, xcap::image::RgbaImage)>> {
        let mut out = Vec::new();
        for m in xcap::Monitor::all().map_err(|e| anyhow!("{e}"))? {
            let img = m.capture_image().map_err(|e| anyhow!("{e}"))?;
            out.push((m.x().unwrap_or(0), m.y().unwrap_or(0), img.width(), img.height(), img));
        }
        Ok(out)
    })
    .await
    .map_err(|e| anyhow!("{e}"))?;

    let captured = match captured {
        Ok(c) if !c.is_empty() => c,
        Ok(_) => {
            show_main(&app);
            return Err(anyhow!("Morf couldn't see any screens."));
        }
        Err(e) => {
            show_main(&app);
            return Err(anyhow!("Morf couldn't capture the screen: {e}"));
        }
    };

    let cursor = app.cursor_position().ok();
    let mut focus = 0usize;
    let mut shots = Vec::with_capacity(captured.len());
    for (i, (x, y, w, h, img)) in captured.into_iter().enumerate() {
        if let Some(c) = cursor {
            if c.x >= x as f64 && c.x < x as f64 + w as f64 && c.y >= y as f64 && c.y < y as f64 + h as f64 {
                focus = i;
            }
        }
        shots.push((x, y, w, h));
        app.state::<Picker>().shots.lock().unwrap().push(img);
    }

    for (i, (x, y, w, h)) in shots.iter().enumerate() {
        let label = format!("{PREFIX}{i}");
        let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html#{label}").into()))
            .title("Morf colour picker")
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .background_color(tauri::window::Color(0, 0, 0, 255))
            .build()?;
        let _ = win.set_position(PhysicalPosition::new(*x, *y));
        let _ = win.set_size(PhysicalSize::new(*w, *h));
    }
    // The windows show themselves once their still is drawn (see `picker_ready`), so there's no
    // white flash. Remember which one should take the keyboard.
    app.state::<Picker>().focus.lock().unwrap().replace(focus);
    Ok(())
}

/// The still for one monitor: width and height (u32, little-endian), then RGBA pixels.
pub fn shot(app: &AppHandle, index: usize) -> Result<Vec<u8>> {
    let state = app.state::<Picker>();
    let shots = state.shots.lock().unwrap();
    let img = shots.get(index).ok_or_else(|| anyhow!("No still for this screen."))?;
    let mut out = Vec::with_capacity(8 + img.as_raw().len());
    out.extend_from_slice(&img.width().to_le_bytes());
    out.extend_from_slice(&img.height().to_le_bytes());
    out.extend_from_slice(img.as_raw());
    Ok(out)
}

/// A picker window has drawn its still: show it, and focus the one under the cursor.
pub fn ready(app: &AppHandle, index: usize) {
    let Some(win) = app.get_webview_window(&format!("{PREFIX}{index}")) else { return };
    let _ = win.show();
    let focus = *app.state::<Picker>().focus.lock().unwrap();
    if focus == Some(index) {
        let _ = win.set_focus();
    }
}

/// Closes every picker window, brings Morf back and tells it what was picked (or nothing).
pub fn done(app: &AppHandle, hex: Option<String>) {
    for (label, win) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = win.destroy();
        }
    }
    let state = app.state::<Picker>();
    state.shots.lock().unwrap().clear();
    state.focus.lock().unwrap().take();
    show_main(app);
    let _ = app.emit("morf://picked", Picked { hex });
}
