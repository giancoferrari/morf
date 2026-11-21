//! External tools (ffmpeg): finding it, asking what it can do, and running it
//! with progress and Stop.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, Result};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

/* ------------------------------------------------------------------------------------------------
 * Stop
 * ----------------------------------------------------------------------------------------------*/

/// Raised when a job was stopped on purpose. The window shows "Stopped", not an error.
#[derive(Debug)]
pub struct Stopped;
impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Stopped")
    }
}
impl std::error::Error for Stopped {}

#[derive(Clone)]
pub struct Cancel {
    tx: Arc<watch::Sender<bool>>,
    rx: watch::Receiver<bool>,
}

impl Cancel {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self { tx: Arc::new(tx), rx }
    }
    pub fn cancel(&self) {
        self.tx.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }
    /// Between steps of in-process work.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() { Err(Stopped.into()) } else { Ok(()) }
    }
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        let _ = rx.wait_for(|v| *v).await;
    }
}

/* ------------------------------------------------------------------------------------------------
 * Finding tools
 * ----------------------------------------------------------------------------------------------*/

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

/// Looked up on every use, so installing ffmpeg while Morf is open works without a restart.
/// Order: bundled next to Morf, the PATH, then places package managers put things that a GUI
/// app's PATH often lacks.
pub fn find_tool(name: &str) -> Option<(PathBuf, bool)> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join(format!("{name}{EXE}")), dir.join("binaries").join(format!("{name}{EXE}"))] {
                if candidate.is_file() {
                    return Some((candidate, true));
                }
            }
        }
    }
    if let Ok(p) = which::which(name) {
        return Some((p, false));
    }
    let mut extra: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        extra.push("/opt/homebrew/bin".into());
        extra.push("/usr/local/bin".into());
    }
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            extra.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
    }
    extra.into_iter().map(|d| d.join(format!("{name}{EXE}"))).find(|p| p.is_file()).map(|p| (p, false))
}

pub fn ffmpeg() -> Result<PathBuf> {
    find_tool("ffmpeg").map(|(p, _)| p).ok_or_else(|| anyhow!("ffmpeg isn't installed. Reinstall Morf, or install ffmpeg."))
}

pub fn command(path: &Path) -> Command {
    let mut c = Command::new(path);
    c.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window flashing up for every conversion.
        c.creation_flags(0x0800_0000);
    }
    c
}

/* ------------------------------------------------------------------------------------------------
 * What this ffmpeg can do. Cached per copy (path + size + date), asked again for a different one.
 * ----------------------------------------------------------------------------------------------*/

#[derive(Clone, Default)]
pub struct Capabilities {
    pub version: String,
    pub encoders: HashSet<String>,
    /// Hardware H.264 and HEVC encoders that passed a test encode, e.g. ("h264_nvenc", "hevc_nvenc").
    pub hw_h264: Option<String>,
    pub hw_hevc: Option<String>,
}

impl Capabilities {
    pub fn has(&self, enc: &str) -> bool {
        self.encoders.contains(enc)
    }
}

static CAPS: OnceLock<Mutex<Option<(String, Capabilities)>>> = OnceLock::new();

fn fingerprint(p: &Path) -> String {
    let meta = std::fs::metadata(p).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    format!("{}|{len}|{modified}", p.display())
}

pub async fn capabilities() -> Result<Capabilities> {
    let path = ffmpeg()?;
    let key = fingerprint(&path);
    let cell = CAPS.get_or_init(|| Mutex::new(None));
    if let Some((k, caps)) = cell.lock().unwrap().as_ref() {
        if *k == key {
            return Ok(caps.clone());
        }
    }

    let out = command(&path).arg("-version").output().await?;
    let version = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(2))
        .unwrap_or("unknown")
        .to_string();

    let out = command(&path).args(["-hide_banner", "-encoders"]).output().await?;
    let mut encoders = HashSet::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // " V....D libx264  libx264 H.264 / AVC ..."
        let mut parts = line.split_whitespace();
        if let (Some(flags), Some(name)) = (parts.next(), parts.next()) {
            if flags.len() == 6 && flags.chars().all(|c| c.is_ascii_alphabetic() || c == '.') {
                encoders.insert(name.to_string());
            }
        }
    }

    let families: &[&str] = if cfg!(target_os = "macos") { &["videotoolbox"] } else { &["nvenc", "qsv", "amf"] };
    let mut caps = Capabilities { version, encoders, hw_h264: None, hw_hevc: None };
    for fam in families {
        let h264 = format!("h264_{fam}");
        if caps.hw_h264.is_none() && caps.has(&h264) && test_encode(&path, &h264).await {
            caps.hw_h264 = Some(h264);
        }
        let hevc = format!("hevc_{fam}");
        if caps.hw_hevc.is_none() && caps.has(&hevc) && test_encode(&path, &hevc).await {
            caps.hw_hevc = Some(hevc);
        }
    }

    *cell.lock().unwrap() = Some((key, caps.clone()));
    Ok(caps)
}

/// An encoder can be listed and still fail (no GPU, old driver). Three frames tell.
async fn test_encode(ffmpeg: &Path, encoder: &str) -> bool {
    let fut = command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:r=30:d=0.2", "-frames:v", "3", "-c:v", encoder, "-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(tokio::time::timeout(std::time::Duration::from_secs(8), fut).await, Ok(Ok(s)) if s.success())
}

/* ------------------------------------------------------------------------------------------------
 * Running ffmpeg
 * ----------------------------------------------------------------------------------------------*/

/// Runs ffmpeg with `args`, reporting 0…1 progress against `duration` seconds. Stop kills it.
/// The error is ffmpeg's own last meaningful line, which is usually the one that explains.
pub async fn run_ffmpeg(args: &[String], duration: Option<f64>, cwd: Option<&Path>, cancel: &Cancel, mut progress: impl FnMut(f64) + Send) -> Result<()> {
    let path = ffmpeg()?;
    let mut cmd = command(&path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    // Keep only the tail of stderr: a broken file can make ffmpeg print megabytes.
    let tail = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let tail_w = tail.clone();
    let err_task = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut t = tail_w.lock().unwrap();
            t.extend(&buf[..n]);
            while t.len() > 64 * 1024 {
                t.pop_front();
            }
        }
    });

    let mut lines = BufReader::new(stdout).lines();
    let total = duration.filter(|d| *d > 0.0);
    let status = loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let (Some(total), Some(v)) = (total, l.strip_prefix("out_time_us=").or_else(|| l.strip_prefix("out_time_ms="))) {
                            if let Ok(us) = v.trim().parse::<f64>() {
                                progress((us / 1_000_000.0 / total).clamp(0.0, 0.999));
                            }
                        }
                    }
                    _ => break child.wait().await?,
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = err_task.await;
                return Err(Stopped.into());
            }
        }
    };
    let _ = err_task.await;
    if status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&tail.lock().unwrap().iter().copied().collect::<Vec<_>>()).to_string();
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("Conversion failed"))
        .unwrap_or("ffmpeg stopped with an error")
        .to_string();
    Err(anyhow!(clean_ffmpeg_error(&line)))
}

/// ffmpeg errors start with "[component @ 0x…]"; people don't need that part.
fn clean_ffmpeg_error(line: &str) -> String {
    let s = if line.starts_with('[') { line.split_once("] ").map(|(_, r)| r).unwrap_or(line) } else { line };
    let mut s = s.to_string();
    if let Some(c) = s.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    s
}
