//! Morf's engine: the commands the window calls, and the app's startup.

mod av;
mod catalog;
mod dictate;
mod extra;
mod img;
mod jobs;
mod overlay;
mod paths;
mod pdf;
mod pdfsec;
mod picker;
mod probe;
mod shell;
mod tools;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Files Morf was asked to open (command line, right-click menu, a second launch), waiting for
/// the window to take them.
#[derive(Default)]
struct Launch {
    paths: Vec<String>,
    tool: Option<String>,
}

#[derive(Serialize)]
struct LaunchFiles {
    paths: Vec<String>,
    tool: Option<String>,
}

/// `morf [--tool convert|compress] file…`
fn parse_args(args: &[String]) -> Launch {
    let mut l = Launch::default();
    let mut it = args.iter().skip(1).peekable();
    while let Some(a) = it.next() {
        if a == "--tool" {
            l.tool = it.next().cloned();
        } else if !a.starts_with("--") {
            l.paths.push(a.clone());
        }
    }
    l
}

#[tauri::command]
async fn catalog() -> Vec<catalog::Target> {
    let caps = tools::capabilities().await.ok();
    catalog::available(caps.as_ref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegInfo {
    path: String,
    version: String,
    bundled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    ffmpeg: Option<FfmpegInfo>,
    hw_encoders: Vec<String>,
    platform: &'static str,
    shell_menu: bool,
}

#[tauri::command]
async fn engine_status() -> EngineStatus {
    let found = tools::find_tool("ffmpeg");
    let caps = tools::capabilities().await.ok();
    EngineStatus {
        ffmpeg: found.map(|(p, bundled)| FfmpegInfo {
            path: p.to_string_lossy().into_owned(),
            version: caps.as_ref().map(|c| c.version.clone()).unwrap_or_default(),
            bundled,
        }),
        hw_encoders: caps.map(|c| [c.hw_h264, c.hw_hevc].into_iter().flatten().collect()).unwrap_or_default(),
        platform: if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
        shell_menu: shell::installed(),
    }
}

#[tauri::command]
async fn inspect(paths: Vec<String>) -> Vec<probe::FileInfo> {
    let tasks: Vec<_> = paths.into_iter().map(|p| tauri::async_runtime::spawn(async move { probe::inspect(&p).await })).collect();
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        if let Ok(info) = t.await {
            out.push(info);
        }
    }
    out
}

#[tauri::command]
fn start_job(app: AppHandle, jobs: State<'_, Arc<jobs::Jobs>>, req: jobs::JobRequest) {
    jobs::start(app, jobs.inner().clone(), req);
}

#[tauri::command]
fn cancel_job(jobs: State<'_, Arc<jobs::Jobs>>, job_id: String) {
    jobs.cancel(&job_id);
}

#[tauri::command]
fn take_launch_files(launch: State<'_, Mutex<Launch>>) -> LaunchFiles {
    let mut l = launch.lock().unwrap();
    LaunchFiles { paths: std::mem::take(&mut l.paths), tool: l.tool.take() }
}

#[tauri::command]
fn set_shell_menu(enabled: bool) -> Result<bool, String> {
    let r = if enabled { shell::install() } else { shell::uninstall() };
    r.map_err(|e| e.to_string())?;
    Ok(shell::installed())
}

/// `morf --cli convert <format> <file>…` / `morf --cli compress <light|balanced|strong|NN mb> <file>…`
/// Runs without a window, prints one line per file. `morf --cli formats` lists format IDs.
/// MORF_SETTINGS='{"quality":60}' passes extra settings. Used by tests and scripts.
fn run_cli(args: &[String]) -> i32 {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    rt.block_on(async {
        let op = args.first().map(String::as_str).unwrap_or("");
        // `--cli transcribe <model.gguf> <audio>`: checks the speech engine without the window.
        if op == "transcribe" && args.len() >= 3 {
            let started = std::time::Instant::now();
            let r = (|| -> anyhow::Result<String> {
                let out = std::process::Command::new(tools::ffmpeg()?)
                    .args(["-hide_banner", "-loglevel", "error", "-i", &args[2], "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
                    .output()?;
                let pcm: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                let model = transcribe_cpp::Model::load(&args[1]).map_err(|e| anyhow::anyhow!("{e}"))?;
                let mut session = model.session().map_err(|e| anyhow::anyhow!("{e}"))?;
                let t = session.run(&pcm, &transcribe_cpp::RunOptions::default()).map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(t.text)
            })();
            return match r {
                Ok(text) => {
                    println!("ok    ({:.1}s) {text}", started.elapsed().as_secs_f64());
                    0
                }
                Err(e) => {
                    println!("FAIL  {e}");
                    1
                }
            };
        }
        if op == "fetch-model" && args.len() >= 3 {
            return match dictate::cli_fetch_model(&args[1], std::path::Path::new(&args[2])) {
                Ok(p) => {
                    println!("ok    {}", p.display());
                    0
                }
                Err(e) => {
                    println!("FAIL  {e}");
                    1
                }
            };
        }
        if op == "formats" {
            let caps = tools::capabilities().await.ok();
            for t in catalog::available(caps.as_ref()) {
                println!("{:<12} {} {}", t.id, t.label, t.detail.unwrap_or(""));
            }
            return 0;
        }
        if args.len() < 3 || !matches!(op, "convert" | "compress" | "resize") {
            eprintln!("usage: morf --cli convert <format> <file>… | compress <level|NNmb> <file>… | formats");
            return 2;
        }
        let mut settings: jobs::Settings = std::env::var("MORF_SETTINGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut target = None;
        if op == "convert" {
            target = Some(args[1].clone());
        } else if op == "resize" {
            // Settings come from MORF_SETTINGS; the second argument is ignored.
        } else if let Some(mb) = args[1].to_lowercase().strip_suffix("mb").and_then(|v| v.trim().parse::<f64>().ok()) {
            settings.target_mb = Some(mb);
        } else {
            settings.level = serde_json::from_value(serde_json::Value::String(args[1].clone())).ok();
        }
        let mut code = 0;
        for (i, path) in args[2..].iter().enumerate() {
            let req = jobs::JobRequest {
                job_id: format!("cli-{i}"),
                op: op.to_string(),
                path: path.clone(),
                target: target.clone(),
                settings: settings.clone(),
                out_dir: std::env::var("MORF_OUT_DIR").ok(),
                trash_original: false,
            };
            let started = std::time::Instant::now();
            let e = jobs::execute(&req, &tools::Cancel::new(), Arc::new(|_| {})).await;
            let secs = started.elapsed().as_secs_f64();
            match e.state {
                "done" => println!("ok    {path} -> {} ({} bytes, {secs:.1}s){}", e.output.as_deref().unwrap_or("(none)"), e.out_size.unwrap_or(0), e.error.map(|n| format!(" note: {n}")).unwrap_or_default()),
                _ => {
                    code = 1;
                    println!("FAIL  {path}: {}", e.error.unwrap_or_else(|| e.state.to_string()));
                }
            }
        }
        code
    })
}

/* ------------------------------------------------------------------------------------------------
 * Dictation
 * ----------------------------------------------------------------------------------------------*/

#[tauri::command]
fn dictation_settings(app: AppHandle) -> dictate::DictationSettings {
    dictate::load_settings(&app)
}

#[tauri::command]
fn set_dictation_settings(app: AppHandle, settings: dictate::DictationSettings) -> Result<(), String> {
    dictate::save_settings(&app, &settings).map_err(|e| e.to_string())?;
    apply_dictation(&app, &settings)
}

/// Registers (or removes) the global shortcut to match the settings.
fn apply_dictation(app: &AppHandle, settings: &dictate::DictationSettings) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    dictate::ENABLED.store(settings.enabled, std::sync::atomic::Ordering::SeqCst);
    if settings.enabled {
        gs.register(settings.shortcut.as_str())
            .map_err(|e| format!("Couldn't use {} as the shortcut: {e}. Another app may already use it.", settings.shortcut))?;
        app.state::<dictate::Shared>().preload();
    }
    update_tray(app);
    Ok(())
}

#[tauri::command]
fn dictation_models(app: AppHandle) -> Vec<dictate::ModelState> {
    dictate::model_states(&app)
}

#[tauri::command]
fn download_model(app: AppHandle, id: String) {
    dictate::download_model(app, id);
}

#[tauri::command]
fn cancel_model_download() {
    dictate::cancel_download();
}

#[tauri::command]
fn delete_model(app: AppHandle, id: String) -> Result<(), String> {
    dictate::delete_model(&app, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictation_toggle(d: State<'_, dictate::Shared>) {
    d.toggle();
}

#[tauri::command]
fn dictation_cancel(d: State<'_, dictate::Shared>) {
    d.cancel();
}

#[tauri::command]
fn dictation_history(app: AppHandle) -> Vec<dictate::HistoryItem> {
    dictate::load_history(&app)
}

#[tauri::command]
fn clear_dictation_history(app: AppHandle) {
    dictate::clear_history(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Microphone {
    id: String,
    name: String,
    is_default: bool,
}

#[tauri::command]
fn list_microphones() -> Vec<Microphone> {
    handy_recorder::list_input_devices()
        .map(|list| list.into_iter().filter(|d| !d.is_monitor).map(|d| Microphone { id: d.id, name: d.name, is_default: d.is_default }).collect())
        .unwrap_or_default()
}

#[tauri::command]
async fn transcribe_file(app: AppHandle, path: String, model: String, language: String) -> Result<dictate::FileTranscript, String> {
    tauri::async_runtime::spawn_blocking(move || dictate::transcribe_file(&app, std::path::Path::new(&path), &model, &language))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------------------------------------
 * Lighter tools
 * ----------------------------------------------------------------------------------------------*/

#[tauri::command]
async fn image_preview(path: String) -> Result<String, String> {
    extra::image_preview(&path).await.map_err(|e| e.to_string())
}

/// The bytes of a displayable version of an image, sent as raw binary. The window turns them into
/// a same-origin blob, so tools can read pixels from a canvas.
#[tauri::command]
async fn image_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let shown = extra::image_preview(&path).await.map_err(|e| e.to_string())?;
    let bytes = std::fs::read(shown).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A file's bytes as raw binary (PDFs for Read). Capped so a mistaken drop can't fill memory.
#[tauri::command]
fn file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > 400_000_000 {
        return Err("This file is too large (over 400 MB).".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    extra::read_text(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_bytes(path: String, data: String) -> Result<(), String> {
    extra::save_bytes(&path, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_beside(beside: String, suffix: String, ext: String, data: String, text: bool) -> Result<String, String> {
    extra::save_beside(&beside, &suffix, &ext, &data, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn storage_info(app: AppHandle) -> Result<extra::Storage, String> {
    extra::storage(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_previews() -> Result<(), String> {
    extra::clear_previews().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_cutout_model(app: AppHandle) -> Result<(), String> {
    extra::delete_cutout_model(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn folder_beside(beside: String, suffix: String) -> Result<String, String> {
    extra::folder_beside(&beside, &suffix).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pdf_protect(req: pdfsec::Protect) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pdfsec::protect(req)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pdf_unlock(path: String, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pdfsec::unlock(&path, &password)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pdf_needs_password(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || pdfsec::needs_password(&path)).await.unwrap_or(false)
}

#[tauri::command]
fn rename_files(pairs: Vec<extra::RenamePair>) -> Vec<extra::RenameResult> {
    extra::rename_files(pairs)
}

#[tauri::command]
async fn apply_cutout(path: String, mask: String, crop: bool) -> Result<String, String> {
    extra::apply_cutout(&path, &mask, crop).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuxModel {
    path: Option<String>,
    size: u64,
}

#[tauri::command]
fn cutout_model(app: AppHandle) -> AuxModel {
    let p = extra::cutout_model_path(&app).ok().filter(|p| p.is_file());
    AuxModel { path: p.map(|p| p.to_string_lossy().into_owned()), size: extra::CUTOUT_MODEL.2 }
}

#[tauri::command]
fn download_cutout_model(app: AppHandle) -> Result<(), String> {
    let dest = extra::cutout_model_path(&app).map_err(|e| e.to_string())?;
    let (_, url, size, sha) = extra::CUTOUT_MODEL;
    dictate::download_verified(app, "cutout".into(), url.into(), size, sha.into(), dest);
    Ok(())
}

/* ------------------------------------------------------------------------------------------------
 * Palette: pick a colour from the screen
 * ----------------------------------------------------------------------------------------------*/

#[tauri::command]
async fn pick_screen_colour(app: AppHandle) -> Result<(), String> {
    picker::open(app).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn picker_shot(app: AppHandle, index: usize) -> Result<tauri::ipc::Response, String> {
    picker::shot(&app, index).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn picker_ready(app: AppHandle, index: usize) {
    picker::ready(&app, index);
}

#[tauri::command]
fn picker_done(app: AppHandle, hex: Option<String>) {
    picker::done(&app, hex);
}

/* ------------------------------------------------------------------------------------------------
 * Tray: keeps dictation reachable while the window is closed
 * ----------------------------------------------------------------------------------------------*/

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "Open Morf", true, None::<&str>)?;
    let dictate = MenuItem::with_id(app, "dictate", "Start or stop dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Morf", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &dictate, &sep, &quit])?;
    TrayIconBuilder::with_id("morf")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("Morf")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "dictate" => app.state::<dictate::Shared>().toggle(),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn update_tray(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("morf") {
        let s = dictate::load_settings(app);
        let tip = if s.enabled { format!("Morf · dictation on ({})", s.shortcut) } else { "Morf".to_string() };
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("--cli") {
        std::process::exit(run_cli(&argv[2..]));
    }
    let first = parse_args(&argv);

    tauri::Builder::default()
        // A second launch (right-click on more files) hands its files to the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let l = parse_args(&argv);
            if !l.paths.is_empty() {
                let state = app.state::<Mutex<Launch>>();
                let mut s = state.lock().unwrap();
                s.paths.extend(l.paths);
                if l.tool.is_some() {
                    s.tool = l.tool;
                }
            }
            let _ = app.emit("morf://open", ());
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // "Open at sign-in": starts quietly in the tray (see `--autostart` in setup).
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if !dictate::ENABLED.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    let d = app.state::<dictate::Shared>();
                    match event.state() {
                        ShortcutState::Pressed => d.press(),
                        ShortcutState::Released => d.release(),
                    }
                })
                .build(),
        )
        .manage(Mutex::new(first))
        .manage(Arc::new(jobs::Jobs::default()))
        .manage(picker::Picker::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Ask ffmpeg what it can do now, so the first conversion doesn't wait for it.
            tauri::async_runtime::spawn(async {
                let _ = tools::capabilities().await;
            });
            let handle = app.handle().clone();
            app.manage::<dictate::Shared>(Arc::new(dictate::start(&handle)));
            overlay::create(&handle)?;
            create_tray(&handle)?;
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let settings = dictate::load_settings(&handle);
            if let Err(e) = apply_dictation(&handle, &settings) {
                log::warn!("{e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // With dictation on, closing the window keeps Morf in the tray so the shortcut works.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if dictate::ENABLED.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
                // Closing the window is Stop: running jobs end and clean up after themselves.
                tauri::WindowEvent::Destroyed => window.state::<Arc<jobs::Jobs>>().cancel_all(),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            catalog,
            engine_status,
            inspect,
            start_job,
            cancel_job,
            take_launch_files,
            set_shell_menu,
            dictation_settings,
            set_dictation_settings,
            dictation_models,
            download_model,
            cancel_model_download,
            delete_model,
            dictation_toggle,
            dictation_cancel,
            dictation_history,
            clear_dictation_history,
            list_microphones,
            transcribe_file,
            image_preview,
            image_bytes,
            file_bytes,
            read_text,
            save_bytes,
            save_beside,
            rename_files,
            apply_cutout,
            cutout_model,
            download_cutout_model,
            pick_screen_colour,
            picker_shot,
            picker_ready,
            picker_done,
            folder_beside,
            pdf_protect,
            pdf_unlock,
            pdf_needs_password,
            storage_info,
            clear_previews,
            delete_cutout_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Morf");
}
