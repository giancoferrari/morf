//! Morf's engine: the commands the window calls, and the app's startup.

mod av;
mod catalog;
mod img;
mod jobs;
mod paths;
mod pdf;
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
        if op == "formats" {
            let caps = tools::capabilities().await.ok();
            for t in catalog::available(caps.as_ref()) {
                println!("{:<12} {} {}", t.id, t.label, t.detail.unwrap_or(""));
            }
            return 0;
        }
        if args.len() < 3 || !matches!(op, "convert" | "compress") {
            eprintln!("usage: morf --cli convert <format> <file>… | compress <level|NNmb> <file>… | formats");
            return 2;
        }
        let mut settings: jobs::Settings = std::env::var("MORF_SETTINGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut target = None;
        if op == "convert" {
            target = Some(args[1].clone());
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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(first))
        .manage(Arc::new(jobs::Jobs::default()))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Ask ffmpeg what it can do now, so the first conversion doesn't wait for it.
            tauri::async_runtime::spawn(async {
                let _ = tools::capabilities().await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window is Stop: running jobs end and clean up after themselves.
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<Arc<jobs::Jobs>>().cancel_all();
            }
        })
        .invoke_handler(tauri::generate_handler![catalog, engine_status, inspect, start_job, cancel_job, take_launch_files, set_shell_menu])
        .run(tauri::generate_context!())
        .expect("error while running Morf");
}
