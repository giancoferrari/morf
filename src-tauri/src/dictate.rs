//! Dictation: hold a shortcut, speak, let go, and the words are typed into whatever app is in
//! front. The behaviour follows Handy (github.com/cjpais/Handy, MIT) and uses its building blocks:
//! handy-recorder for the microphone, earshot to cut silence, and transcribe.cpp with the same
//! GGUF models. Everything runs on this computer; only the model is downloaded, once.
//!
//! One controller thread owns the microphone and the loaded model. The shortcut handler and the
//! window's commands send it messages, so recording, transcribing and pasting never overlap.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use handy_recorder::{AudioChunk, Recorder, RecorderConfig, Sink};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/* ------------------------------------------------------------------------------------------------
 * Models (the same pinned GGUF files Handy offers)
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub languages: &'static str,
    pub size: u64,
    pub recommended: bool,
    #[serde(skip)]
    repo: &'static str,
    #[serde(skip)]
    revision: &'static str,
    #[serde(skip)]
    file: &'static str,
    #[serde(skip)]
    sha256: &'static str,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "parakeet-tdt-0.6b-v3",
        name: "Parakeet V3",
        description: "Fast and accurate. The best pick for most people.",
        languages: "25 European languages, detected automatically",
        size: 739_508_576,
        recommended: true,
        repo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
        revision: "85ac09ea12fc4b1112fa76810059364bc6adc9de",
        file: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
        sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
    },
    ModelInfo {
        id: "parakeet-tdt_ctc-110m",
        name: "Parakeet Tiny",
        description: "Virtually instant, even on older computers.",
        languages: "English",
        size: 135_373_280,
        recommended: false,
        repo: "handy-computer/parakeet-tdt_ctc-110m-gguf",
        revision: "9d66d34f9e1594075c5dd72c90c0f4c321b29f21",
        file: "parakeet-tdt_ctc-110m-Q8_0.gguf",
        sha256: "7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296",
    },
    ModelInfo {
        id: "whisper-small",
        name: "Whisper Small",
        description: "Many languages in a small download.",
        languages: "99 languages",
        size: 269_751_136,
        recommended: false,
        repo: "handy-computer/whisper-small-gguf",
        revision: "c0214bd34be9296695486f838e0142f900803159",
        file: "whisper-small-Q8_0.gguf",
        sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
    },
    ModelInfo {
        id: "whisper-large-v3-turbo",
        name: "Whisper Large Turbo",
        description: "Most accurate across languages. Slower without a graphics card.",
        languages: "100 languages",
        size: 886_381_760,
        recommended: false,
        repo: "handy-computer/whisper-large-v3-turbo-gguf",
        revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
        file: "whisper-large-v3-turbo-Q8_0.gguf",
        sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
    },
];

fn model_info(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn model_path(app: &AppHandle, m: &ModelInfo) -> Result<PathBuf> {
    Ok(models_dir(app)?.join(m.file))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    #[serde(flatten)]
    pub info: ModelInfo,
    pub downloaded: bool,
}

pub fn model_states(app: &AppHandle) -> Vec<ModelState> {
    MODELS
        .iter()
        .map(|m| ModelState { info: m.clone(), downloaded: model_path(app, m).map(|p| p.is_file()).unwrap_or(false) })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    state: &'static str,
    received: u64,
    total: u64,
    error: Option<String>,
}

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

pub fn cancel_download() {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
}

/// Downloads a model from Hugging Face at its pinned revision and checks its SHA-256 before
/// keeping it. Progress goes out as `morf://model` events.
pub fn download_model(app: AppHandle, id: String) {
    let Some(m) = model_info(&id) else { return };
    let url = format!("https://huggingface.co/{}/resolve/{}/{}", m.repo, m.revision, m.file);
    match model_path(&app, m) {
        Ok(dest) => download_verified(app, id, url, m.size, m.sha256.to_string(), dest),
        Err(e) => {
            let _ = app.emit("morf://model", DownloadEvent { id, state: "failed", received: 0, total: 0, error: Some(e.to_string()) });
        }
    }
}

/// Fetches `url` to `dest` on a thread, checking the SHA-256 before the file is kept. Used for
/// speech models and Cutout's model. Progress goes out as `morf://model` events tagged with `id`.
pub fn download_verified(app: AppHandle, id: String, url: String, size: u64, sha256: String, dest: PathBuf) {
    std::thread::spawn(move || {
        DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
        let emit = |state: &'static str, received: u64, total: u64, error: Option<String>| {
            let _ = app.emit("morf://model", DownloadEvent { id: id.clone(), state, received, total, error });
        };
        let mut last = Instant::now();
        let result = fetch_verified(&url, size, &sha256, &dest, &DOWNLOAD_CANCEL, |received, total| {
            if last.elapsed() > Duration::from_millis(150) {
                last = Instant::now();
                emit("downloading", received, total, None);
            }
        });
        match result {
            Ok(n) => emit("done", n, n, None),
            Err(e) => {
                let msg = e.to_string();
                emit(if msg == "cancelled" { "cancelled" } else { "failed" }, 0, 0, (msg != "cancelled").then_some(msg));
            }
        }
    });
}

/// Streams `url` into `dest.part`, hashing as it goes; renames into place only when the SHA-256
/// matches. Nothing half-downloaded or damaged is ever left under the real name.
pub fn fetch_verified(url: &str, size: u64, sha256: &str, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<u64> {
    let part = dest.with_extension("part");
    let resp = ureq::get(url).call().context("Couldn't reach the download server. Check your internet connection.")?;
    let total = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(size);
    let mut reader = resp.into_body().into_with_config().limit(u64::MAX).reader();
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut received = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("cancelled");
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        received += n as u64;
        progress(received, total);
    }
    file.flush()?;
    drop(file);
    let digest = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if digest != sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("The download was damaged. Try again.");
    }
    std::fs::rename(&part, dest)?;
    Ok(received)
}

/// `--cli fetch-model <id> <folder>`: downloads a speech model exactly as the app does.
pub fn cli_fetch_model(id: &str, folder: &Path) -> Result<PathBuf> {
    let m = model_info(id).ok_or_else(|| anyhow!("Unknown model {id}"))?;
    let url = format!("https://huggingface.co/{}/resolve/{}/{}", m.repo, m.revision, m.file);
    let dest = folder.join(m.file);
    fetch_verified(&url, m.size, m.sha256, &dest, &AtomicBool::new(false), |_, _| {})?;
    Ok(dest)
}

pub fn delete_model(app: &AppHandle, id: &str) -> Result<()> {
    let m = model_info(id).ok_or_else(|| anyhow!("Unknown model"))?;
    let p = model_path(app, m)?;
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

/* ------------------------------------------------------------------------------------------------
 * Settings
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DictationSettings {
    pub enabled: bool,
    pub model: String,
    /// e.g. "ctrl+space". Parsed by the global-shortcut plugin.
    pub shortcut: String,
    /// "auto": hold to talk, or tap to start and tap again to stop. "hold" and "toggle" are strict.
    pub mode: String,
    /// "auto" or an ISO code.
    pub language: String,
    /// "paste" types into the focused app; "copy" only puts the text on the clipboard.
    pub output: String,
    pub remove_fillers: bool,
    pub sounds: bool,
    pub overlay: bool,
    pub microphone: Option<String>,
    pub vocabulary: Vec<String>,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            model: "parakeet-tdt-0.6b-v3".into(),
            shortcut: if cfg!(target_os = "macos") { "alt+space".into() } else { "ctrl+space".into() },
            mode: "auto".into(),
            language: "auto".into(),
            output: "paste".into(),
            remove_fillers: true,
            sounds: true,
            overlay: true,
            microphone: None,
            vocabulary: vec![],
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("dictation.json"))
}

pub fn load_settings(app: &AppHandle) -> DictationSettings {
    settings_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &DictationSettings) -> Result<()> {
    std::fs::write(settings_path(app)?, serde_json::to_vec_pretty(s)?)?;
    Ok(())
}

/* ------------------------------------------------------------------------------------------------
 * History
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub text: String,
    pub at: u64,
    pub seconds: f64,
    pub model: String,
}

fn history_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("dictation-history.json"))
}

pub fn load_history(app: &AppHandle) -> Vec<HistoryItem> {
    history_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn push_history(app: &AppHandle, item: HistoryItem) {
    let mut h = load_history(app);
    h.insert(0, item);
    h.truncate(200);
    if let Ok(p) = history_path(app) {
        let _ = std::fs::write(p, serde_json::to_vec(&h).unwrap_or_default());
    }
}

pub fn clear_history(app: &AppHandle) {
    if let Ok(p) = history_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

/* ------------------------------------------------------------------------------------------------
 * The controller
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictationEvent {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn emit_state(app: &AppHandle, state: &'static str, text: Option<String>, error: Option<String>) {
    let _ = app.emit("morf://dictation", DictationEvent { state, level: None, text, error });
}

enum Msg {
    Press,
    Release,
    Cancel,
    /// Start or stop from the window's button.
    Toggle,
    Preload,
}

pub struct Dictation {
    tx: Mutex<Sender<Msg>>,
}

impl Dictation {
    pub fn press(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Press);
    }
    pub fn release(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Release);
    }
    pub fn cancel(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Cancel);
    }
    pub fn toggle(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Toggle);
    }
    pub fn preload(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Preload);
    }
}

/// Collects 16 kHz mono audio and sends the window a level ~30 times a second.
struct LevelSink {
    app: AppHandle,
    samples: Vec<f32>,
    last: Instant,
    peak: f32,
}

impl Sink for LevelSink {
    fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
        let real = &chunk.samples[..chunk.valid_frames * chunk.channels as usize];
        self.samples.extend_from_slice(real);
        let rms = (real.iter().map(|s| s * s).sum::<f32>() / real.len().max(1) as f32).sqrt();
        self.peak = self.peak.max(rms);
        if self.last.elapsed() > Duration::from_millis(33) {
            self.last = Instant::now();
            // Speech sits around 0.02–0.2 RMS; map that onto 0…1 with a gentle curve.
            let level = (self.peak * 8.0).sqrt().min(1.0);
            self.peak = 0.0;
            let _ = self.app.emit("morf://dictation", DictationEvent { state: "recording", level: Some(level), text: None, error: None });
        }
    }
}

struct Loaded {
    id: String,
    session: transcribe_cpp::Session,
}

pub fn start(app: &AppHandle) -> Dictation {
    let (tx, rx) = mpsc::channel();
    let app2 = app.clone();
    std::thread::Builder::new().name("morf-dictation".into()).spawn(move || controller(app2, rx)).expect("dictation thread");
    Dictation { tx: Mutex::new(tx) }
}

/// Holding the key longer than this means push-to-talk; a shorter tap toggles.
const HOLD_THRESHOLD: Duration = Duration::from_millis(300);

fn controller(app: AppHandle, rx: Receiver<Msg>) {
    let mut recorder: Option<Recorder<LevelSink>> = None;
    let mut loaded: Option<Loaded> = None;
    let mut pressed_at: Option<Instant> = None;
    // In "auto" mode a short tap leaves recording on until the next press.
    let mut latched = false;

    let begin = |recorder: &mut Option<Recorder<LevelSink>>| -> Result<()> {
        let settings = load_settings(&app);
        if model_info(&settings.model).map(|m| !model_path(&app, m).map(|p| p.is_file()).unwrap_or(false)).unwrap_or(true) {
            bail!("Download a model first: open Morf → Dictate.");
        }
        let mut cfg = RecorderConfig::speech();
        cfg.device = settings.microphone.clone();
        let r = Recorder::open(cfg).map_err(|e| anyhow!("Microphone: {e}"))?;
        r.start(LevelSink { app: app.clone(), samples: Vec::with_capacity(16_000 * 30), last: Instant::now(), peak: 0.0 })
            .map_err(|e| anyhow!("Microphone: {}", e.error))?;
        *recorder = Some(r);
        crate::overlay::show(&app);
        emit_state(&app, "recording", None, None);
        Ok(())
    };

    loop {
        let Ok(msg) = rx.recv() else { return };
        let settings = load_settings(&app);
        let result: Result<()> = (|| {
            match msg {
                Msg::Preload => {
                    ensure_model(&app, &mut loaded, &settings.model)?;
                }
                Msg::Cancel => {
                    if let Some(r) = recorder.take() {
                        let _ = r.stop();
                        let _ = r.close();
                    }
                    latched = false;
                    crate::overlay::hide(&app);
                    emit_state(&app, "idle", None, None);
                }
                Msg::Toggle => {
                    if recorder.is_some() {
                        finish(&app, &mut recorder, &mut loaded, &settings)?;
                    } else {
                        begin(&mut recorder)?;
                    }
                }
                Msg::Press => {
                    if recorder.is_some() {
                        // Second tap of a toggle: stop.
                        if latched || settings.mode == "toggle" {
                            latched = false;
                            finish(&app, &mut recorder, &mut loaded, &settings)?;
                        }
                        return Ok(());
                    }
                    pressed_at = Some(Instant::now());
                    begin(&mut recorder)?;
                    // Load the model while the person talks, so the wait at the end is short.
                    let _ = ensure_model(&app, &mut loaded, &settings.model);
                }
                Msg::Release => {
                    let held = pressed_at.take().map(|t| t.elapsed()).unwrap_or_default();
                    if recorder.is_none() {
                        return Ok(());
                    }
                    match settings.mode.as_str() {
                        "toggle" => {}
                        "hold" => finish(&app, &mut recorder, &mut loaded, &settings)?,
                        _ if held < HOLD_THRESHOLD => latched = true,
                        _ => finish(&app, &mut recorder, &mut loaded, &settings)?,
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            if let Some(r) = recorder.take() {
                let _ = r.stop();
                let _ = r.close();
            }
            latched = false;
            crate::overlay::flash_error(&app);
            emit_state(&app, "error", None, Some(e.to_string()));
        }
    }
}

fn ensure_model<'a>(app: &AppHandle, loaded: &'a mut Option<Loaded>, id: &str) -> Result<&'a mut transcribe_cpp::Session> {
    if loaded.as_ref().map(|l| l.id != id).unwrap_or(true) {
        *loaded = None;
        let m = model_info(id).ok_or_else(|| anyhow!("Unknown model"))?;
        let path = model_path(app, m)?;
        if !path.is_file() {
            bail!("Download a model first: open Morf → Dictate.");
        }
        let model = transcribe_cpp::Model::load(&path).map_err(|e| anyhow!("Couldn't load the model: {e}"))?;
        let session = model.session().map_err(|e| anyhow!("Couldn't start the model: {e}"))?;
        *loaded = Some(Loaded { id: id.to_string(), session });
    }
    Ok(&mut loaded.as_mut().unwrap().session)
}

fn finish(app: &AppHandle, recorder: &mut Option<Recorder<LevelSink>>, loaded: &mut Option<Loaded>, settings: &DictationSettings) -> Result<()> {
    let Some(r) = recorder.take() else { return Ok(()) };
    let stopped = r.stop().map_err(|e| anyhow!("Microphone: {e}"))?;
    let _ = r.close();
    let samples = stopped.sink.samples;
    let seconds = samples.len() as f64 / 16_000.0;

    let speech = trim_silence(&samples);
    if speech.len() < 16_000 / 4 {
        crate::overlay::hide(app);
        emit_state(app, "idle", None, None);
        return Ok(());
    }
    emit_state(app, "transcribing", None, None);
    let started = Instant::now();
    let session = ensure_model(app, loaded, &settings.model)?;
    let options = transcribe_cpp::RunOptions {
        language: (settings.language != "auto").then(|| settings.language.clone()),
        vocabulary: settings.vocabulary.clone(),
        ..Default::default()
    };
    // Vocabulary only works on models that support it; retry plainly if this one doesn't.
    let transcript = match session.run(&speech, &options) {
        Ok(t) => t,
        Err(_) if !options.vocabulary.is_empty() => session.run(&speech, &transcribe_cpp::RunOptions { vocabulary: vec![], ..options.clone() }).map_err(|e| anyhow!("{e}"))?,
        Err(e) => bail!("Transcription failed: {e}"),
    };
    let mut text = transcript.text.trim().to_string();
    if settings.remove_fillers {
        text = remove_fillers(&text);
    }
    log::info!("dictation: {:.1}s audio → {} chars in {:?}", seconds, text.len(), started.elapsed());
    crate::overlay::hide(app);
    if text.is_empty() {
        emit_state(app, "idle", None, None);
        return Ok(());
    }
    if settings.output == "copy" {
        arboard::Clipboard::new().and_then(|mut c| c.set_text(text.clone())).map_err(|e| anyhow!("Clipboard: {e}"))?;
    } else {
        paste(&text)?;
    }
    push_history(app, HistoryItem { text: text.clone(), at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), seconds, model: settings.model.clone() });
    emit_state(app, "done", Some(text), None);
    Ok(())
}

/// Keeps the speech and a little air around it, using earshot's voice detector on 16 ms frames.
/// Long pauses inside the recording are shortened too, which makes models faster and steadier.
fn trim_silence(samples: &[f32]) -> Vec<f32> {
    const FRAME: usize = 256;
    let mut det = earshot::Detector::default();
    let voiced: Vec<bool> = samples.chunks(FRAME).map(|c| {
        if c.len() < FRAME {
            let mut f = c.to_vec();
            f.resize(FRAME, 0.0);
            det.predict_f32(&f) >= 0.5
        } else {
            det.predict_f32(c) >= 0.5
        }
    }).collect();
    if !voiced.iter().any(|v| *v) {
        return vec![];
    }
    // Pad each voiced frame by ~250 ms either side.
    let pad = 16;
    let mut keep = vec![false; voiced.len()];
    for (i, v) in voiced.iter().enumerate() {
        if *v {
            for k in i.saturating_sub(pad)..(i + pad + 1).min(voiced.len()) {
                keep[k] = true;
            }
        }
    }
    let mut out = Vec::with_capacity(samples.len());
    let mut gap: VecDeque<f32> = VecDeque::new();
    for (i, chunk) in samples.chunks(FRAME).enumerate() {
        if keep[i] {
            // A pause of up to ~400 ms is kept whole; longer ones are cut to that.
            out.extend(gap.drain(..));
            out.extend_from_slice(chunk);
        } else if !out.is_empty() {
            for s in chunk {
                gap.push_back(*s);
                if gap.len() > 6_400 {
                    gap.pop_front();
                }
            }
        }
    }
    out
}

fn remove_fillers(text: &str) -> String {
    const FILLERS: &[&str] = &["um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "mm", "ah"];
    let mut out: Vec<String> = vec![];
    for word in text.split_whitespace() {
        let bare: String = word.chars().filter(|c| c.is_alphabetic()).collect::<String>().to_lowercase();
        if FILLERS.contains(&bare.as_str()) {
            // Keep sentence punctuation that was attached to the filler.
            if let Some(p) = word.chars().last().filter(|c| matches!(c, '.' | '?' | '!')) {
                if let Some(prev) = out.last_mut() {
                    if !prev.ends_with(['.', '?', '!', ',']) {
                        prev.push(p);
                    }
                }
            }
            continue;
        }
        out.push(word.to_string());
    }
    let mut s = out.join(" ").replace(" ,", ",");
    while s.starts_with([',', ' ']) {
        s.remove(0);
    }
    // Re-capitalise the first letter if a leading filler was removed.
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if text.chars().next().map(|f| f.is_uppercase()).unwrap_or(false) => c.to_uppercase().collect::<String>() + chars.as_str(),
        _ => s,
    }
}

/// Types the text into the focused app: put it on the clipboard, press Ctrl+V (⌘V on a Mac),
/// then put the previous clipboard text back.
fn paste(text: &str) -> Result<()> {
    use enigo::{Direction, Enigo, Keyboard, Key};
    let mut clip = arboard::Clipboard::new().map_err(|e| anyhow!("Clipboard: {e}"))?;
    let previous = clip.get_text().ok();
    clip.set_text(text.to_string()).map_err(|e| anyhow!("Clipboard: {e}"))?;
    std::thread::sleep(Duration::from_millis(60));
    let mut enigo = Enigo::new(&enigo::Settings::default()).map_err(|e| anyhow!("Keyboard: {e}"))?;
    #[cfg(target_os = "macos")]
    let (modifier, v) = (Key::Meta, Key::Other(9));
    #[cfg(target_os = "windows")]
    let (modifier, v) = (Key::Control, Key::Other(0x56));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (modifier, v) = (Key::Control, Key::Unicode('v'));
    enigo.key(modifier, Direction::Press).map_err(|e| anyhow!("Keyboard: {e}"))?;
    enigo.key(v, Direction::Click).map_err(|e| anyhow!("Keyboard: {e}"))?;
    std::thread::sleep(Duration::from_millis(20));
    enigo.key(modifier, Direction::Release).map_err(|e| anyhow!("Keyboard: {e}"))?;
    // Apps read the clipboard when they handle the key; give them a moment before restoring.
    std::thread::sleep(Duration::from_millis(250));
    if let Some(p) = previous {
        let _ = clip.set_text(p);
    }
    Ok(())
}

/* ------------------------------------------------------------------------------------------------
 * Transcribing files
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscript {
    pub text: String,
    pub txt: String,
    pub srt: Option<String>,
}

/// Decodes any audio or video with ffmpeg to 16 kHz mono, transcribes it with the chosen model,
/// and writes `name.txt` (and `name.srt` when the model gives timings) beside the original.
pub fn transcribe_file(app: &AppHandle, path: &Path, model_id: &str, language: &str) -> Result<FileTranscript> {
    let ffmpeg = crate::tools::ffmpeg()?;
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"]).arg(path).args(["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output()?;
    if !out.status.success() {
        bail!("Morf can't read the sound in this file.");
    }
    let pcm: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if pcm.len() < 8_000 {
        bail!("This file has no speech to transcribe.");
    }
    let m = model_info(model_id).ok_or_else(|| anyhow!("Unknown model"))?;
    let model = transcribe_cpp::Model::load(model_path(app, m)?).map_err(|e| anyhow!("Couldn't load the model: {e}"))?;
    let mut session = model.session().map_err(|e| anyhow!("{e}"))?;
    let options = transcribe_cpp::RunOptions { language: (language != "auto").then(|| language.to_string()), ..Default::default() };
    let t = session.run(&pcm, &options).map_err(|e| anyhow!("Transcription failed: {e}"))?;

    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = crate::paths::stem_of(path);
    let txt = crate::paths::unique_path(dir, &stem, "txt");
    std::fs::write(&txt, t.text.trim())?;
    let srt = if t.segments.iter().any(|s| s.t1_ms > 0) {
        let mut body = String::new();
        for (i, s) in t.segments.iter().filter(|s| !s.text.trim().is_empty()).enumerate() {
            body.push_str(&format!("{}\n{} --> {}\n{}\n\n", i + 1, srt_time(s.t0_ms), srt_time(s.t1_ms), s.text.trim()));
        }
        let p = crate::paths::unique_path(dir, &stem, "srt");
        std::fs::write(&p, body)?;
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    };
    Ok(FileTranscript { text: t.text.trim().to_string(), txt: txt.to_string_lossy().into_owned(), srt })
}

fn srt_time(ms: i64) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Shared flag the shortcut handler checks: dictation answers the shortcut only when enabled.
pub static ENABLED: AtomicBool = AtomicBool::new(false);

pub type Shared = Arc<Dictation>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_fillers() {
        assert_eq!(remove_fillers("Um, so I think, uh, we should go."), "So I think, we should go.");
        assert_eq!(remove_fillers("Hello there"), "Hello there");
    }

    #[test]
    fn srt_times() {
        assert_eq!(srt_time(3_723_456), "01:02:03,456");
    }
}
