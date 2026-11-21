//! One job = one file through Convert or Compress. Jobs report progress as events, can be
//! stopped at any point, and never leave a half-written file behind.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::img::{self, NeedsFfmpegDecode, OutFmt};
use crate::probe::Kind;
use crate::tools::{self, Cancel, Stopped};
use crate::{av, catalog, paths, pdf, probe};

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Light,
    Balanced,
    Strong,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub bitrate: Option<String>,
    pub sample_rate: Option<String>,
    pub channels: Option<String>,
    pub bit_depth: Option<String>,
    pub quality: Option<u32>,
    pub resolution: Option<String>,
    pub fps: Option<String>,
    pub keep_audio: Option<bool>,
    pub hardware: Option<bool>,
    pub gif_width: Option<String>,
    pub gif_fps: Option<String>,
    pub image_quality: Option<u32>,
    pub max_size: Option<String>,
    pub level: Option<Level>,
    #[serde(rename = "targetMB")]
    pub target_mb: Option<f64>,
    pub video_codec: Option<String>,
    pub image_format: Option<String>,
    pub audio_format: Option<String>,
    pub max_dimension: Option<String>,
    pub strip_metadata: Option<bool>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub job_id: String,
    pub op: String,
    pub path: String,
    pub target: Option<String>,
    #[serde(default)]
    pub settings: Settings,
    pub out_dir: Option<String>,
    #[serde(default)]
    pub trash_original: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub job_id: String,
    pub state: &'static str,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, Cancel>>,
}

impl Jobs {
    pub fn cancel(&self, id: &str) {
        if let Some(c) = self.running.lock().unwrap().get(id) {
            c.cancel();
        }
    }
    pub fn cancel_all(&self) {
        for c in self.running.lock().unwrap().values() {
            c.cancel();
        }
    }
}

struct Outcome {
    output: Option<PathBuf>,
    out_size: u64,
    fallback: bool,
    note: Option<String>,
}

type Emit = Arc<dyn Fn(JobEvent) + Send + Sync>;

/// Progress events, at most every 80 ms so a fast job doesn't flood the window.
struct Reporter {
    emit: Emit,
    id: String,
    last: Mutex<(Instant, f64)>,
}

impl Reporter {
    fn report(&self, p: f64) {
        let mut last = self.last.lock().unwrap();
        if last.0.elapsed() < Duration::from_millis(80) && (p - last.1).abs() < 0.05 {
            return;
        }
        *last = (Instant::now(), p);
        (self.emit)(JobEvent { job_id: self.id.clone(), state: "running", progress: p, ..Default::default() });
    }
}

pub fn start(app: AppHandle, jobs: Arc<Jobs>, req: JobRequest) {
    let cancel = Cancel::new();
    jobs.running.lock().unwrap().insert(req.job_id.clone(), cancel.clone());
    let emit: Emit = Arc::new(move |e: JobEvent| {
        let _ = app.emit("morf://job", e);
    });
    tauri::async_runtime::spawn(async move {
        let id = req.job_id.clone();
        let event = execute(&req, &cancel, emit.clone()).await;
        jobs.running.lock().unwrap().remove(&id);
        emit(event);
    });
}

/// Runs one job to the end and returns its final event. Shared by the window and `--cli`.
pub async fn execute(req: &JobRequest, cancel: &Cancel, emit: Emit) -> JobEvent {
    let id = req.job_id.clone();
    let reporter = Arc::new(Reporter { emit, id: id.clone(), last: Mutex::new((Instant::now(), -1.0)) });
    reporter.report(0.0);
    match run(req, cancel, reporter).await {
        Ok(o) => {
            if req.trash_original && o.output.is_some() {
                // Only once the new file exists next to it; it can be put back from the Trash.
                let _ = trash::delete(&req.path);
            }
            JobEvent {
                job_id: id,
                state: "done",
                progress: 1.0,
                output: o.output.map(|p| p.to_string_lossy().into_owned()),
                out_size: Some(o.out_size),
                fallback: o.fallback.then_some(true),
                error: o.note,
            }
        }
        Err(e) if e.is::<Stopped>() => JobEvent { job_id: id, state: "stopped", progress: 0.0, ..Default::default() },
        Err(e) => JobEvent { job_id: id, state: "failed", progress: 0.0, error: Some(format!("{e:#}")), ..Default::default() },
    }
}

/// A part file that deletes itself unless committed.
struct Part {
    path: PathBuf,
    done: bool,
}
impl Drop for Part {
    fn drop(&mut self) {
        if !self.done {
            paths::discard(&self.path);
        }
    }
}

/// A scratch folder for one job, removed afterwards.
struct Scratch(PathBuf);
impl Scratch {
    fn new(id: &str) -> Result<Self> {
        let dir = std::env::temp_dir().join(format!("morf-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run(req: &JobRequest, cancel: &Cancel, rep: Arc<Reporter>) -> Result<Outcome> {
    let input = PathBuf::from(&req.path);
    let info = probe::inspect(&req.path).await;
    if let Some(problem) = info.problem {
        bail!(problem);
    }
    let (dir, fallback) = paths::output_dir(&input, req.out_dir.as_deref().map(Path::new));
    let stem = paths::stem_of(&input);
    let prog = {
        let r = rep.clone();
        move |p: f64| r.report(p)
    };

    match req.op.as_str() {
        "convert" => {
            let id = req.target.as_deref().ok_or_else(|| anyhow!("No format chosen."))?;
            let target = catalog::find(id).ok_or_else(|| anyhow!("Unknown format {id}."))?;
            if !target.accepts.contains(&info.kind) {
                bail!("A {} can't become {}.", format!("{:?}", info.kind).to_lowercase(), target.label);
            }
            let final_path = paths::unique_path(&dir, &stem, target.ext);
            let mut part = Part { path: paths::part_path(&final_path), done: false };
            let scratch = Scratch::new(&req.job_id)?;

            if target.group == "image" {
                convert_image(&input, id, &req.settings, &part.path, &scratch.0, cancel, &prog).await?;
            } else {
                let caps = tools::capabilities().await?;
                let media = av::probe(&input).await;
                let build = |st: &Settings| -> Vec<String> {
                    let mut args = vec!["-i".to_string(), input.to_string_lossy().into_owned()];
                    args.extend(if target.group == "audio" { av::audio_args(id, st, &media, &caps) } else { av::video_args(id, st, &media, &caps) });
                    args.push(part.path.to_string_lossy().into_owned());
                    args
                };
                if target.group == "audio" && !media.has_audio {
                    bail!("This file has no sound to convert.");
                }
                let first = tools::run_ffmpeg(&build(&req.settings), media.duration, None, cancel, &prog).await;
                // A hardware encoder can pass the test and still refuse a real file: try once in software.
                if let Err(e) = first {
                    let used_hw = req.settings.hardware.unwrap_or(true) && (caps.hw_h264.is_some() || caps.hw_hevc.is_some()) && matches!(id, "mp4-h264" | "mkv" | "mp4-hevc");
                    if e.is::<Stopped>() || !used_hw {
                        return Err(e);
                    }
                    paths::discard(&part.path);
                    let mut soft = req.settings.clone();
                    soft.hardware = Some(false);
                    tools::run_ffmpeg(&build(&soft), media.duration, None, cancel, &prog).await?;
                }
            }
            cancel.check()?;
            let out = paths::commit(&part.path, &final_path)?;
            part.done = true;
            let size = std::fs::metadata(&out)?.len();
            Ok(Outcome { output: Some(out), out_size: size, fallback, note: None })
        }
        "compress" => compress(req, &info, &input, &dir, &stem, fallback, cancel, &prog).await,
        other => bail!("Unknown operation {other}"),
    }
}

/// Decodes with the image crate, or through ffmpeg for HEIC, AVIF and camera RAW.
async fn load_image(input: &Path, scratch: &Path, cancel: &Cancel) -> Result<image::DynamicImage> {
    let p = input.to_path_buf();
    match tauri::async_runtime::spawn_blocking(move || img::load(&p)).await? {
        Ok(i) => Ok(i),
        Err(e) if e.is::<NeedsFfmpegDecode>() || e.downcast_ref::<image::ImageError>().is_some() => {
            let tmp = scratch.join("decoded.png");
            let args = vec!["-i".into(), input.to_string_lossy().into_owned(), "-frames:v".into(), "1".into(), "-update".into(), "1".into(), tmp.to_string_lossy().into_owned()];
            tools::run_ffmpeg(&args, None, None, cancel, |_| {}).await.map_err(|_| anyhow!("Morf can't read this image."))?;
            let t = tmp.clone();
            tauri::async_runtime::spawn_blocking(move || img::load(&t)).await?
        }
        Err(e) => Err(e),
    }
}

async fn encode_avif(img: image::DynamicImage, quality: u8, out: &Path, scratch: &Path, cancel: &Cancel) -> Result<()> {
    let caps = tools::capabilities().await?;
    let tmp = scratch.join("avif-source.png");
    let t = tmp.clone();
    tauri::async_runtime::spawn_blocking(move || img.save_with_format(&t, image::ImageFormat::Png)).await??;
    let crf = img::avif_crf(quality).to_string();
    let mut args: Vec<String> = vec!["-i".into(), tmp.to_string_lossy().into_owned(), "-vf".into(), "scale=trunc(iw/2)*2:trunc(ih/2)*2".into(), "-frames:v".into(), "1".into()];
    if caps.has("libaom-av1") {
        args.extend(["-c:v", "libaom-av1", "-still-picture", "1", "-cpu-used", "6", "-row-mt", "1", "-crf", &crf, "-pix_fmt", "yuv420p"].map(String::from));
    } else {
        args.extend(["-c:v", "libsvtav1", "-preset", "6", "-crf", &crf, "-pix_fmt", "yuv420p"].map(String::from));
    }
    args.push(out.to_string_lossy().into_owned());
    tools::run_ffmpeg(&args, None, None, cancel, |_| {}).await
}

async fn convert_image(input: &Path, id: &str, st: &Settings, part: &Path, scratch: &Path, cancel: &Cancel, prog: &(dyn Fn(f64) + Sync)) -> Result<()> {
    prog(0.1);
    let picture = load_image(input, scratch, cancel).await?;
    cancel.check()?;
    prog(0.4);
    let max = img::parse_max(st.max_size.as_deref());
    let quality = st.image_quality.unwrap_or(82).clamp(1, 100) as u8;
    let id_owned = id.to_string();
    let (picture, bytes) = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let p = img::fit(picture, max);
        let b = img::encode_target(&id_owned, &p, quality)?;
        Ok((p, b))
    })
    .await??;
    cancel.check()?;
    prog(0.85);
    match bytes {
        Some(b) => std::fs::write(part, b)?,
        None => encode_avif(picture, quality, part, scratch, cancel).await?,
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn compress(req: &JobRequest, info: &probe::FileInfo, input: &Path, dir: &Path, stem: &str, fallback: bool, cancel: &Cancel, prog: &(dyn Fn(f64) + Sync)) -> Result<Outcome> {
    let st = &req.settings;
    let level = st.level.unwrap_or(Level::Balanced);
    // Size targets leave ~3% for container overhead so the file really lands under the limit.
    let target_bytes = st.target_mb.filter(|m| *m > 0.0).map(|mb| (mb * 1_000_000.0 * 0.97) as u64);
    let scratch = Scratch::new(&req.job_id)?;
    let out_stem = format!("{stem} (compressed)");
    let in_ext = paths::ext_of(input);

    if let Some(t) = target_bytes {
        if info.size <= t {
            return Ok(Outcome { output: None, out_size: info.size, fallback, note: Some("Already under that size; no copy made.".into()) });
        }
    }

    let (part_path, final_path) = match info.kind {
        Kind::Video => {
            let caps = tools::capabilities().await?;
            let media = av::probe(input).await;
            let duration = media.duration.filter(|d| *d > 0.0).ok_or_else(|| anyhow!("Morf can't tell how long this video is."))?;
            let mut audio_kbps = match level { Level::Light => 160, Level::Balanced => 128, Level::Strong => 96 };
            let mut video_kbps = None;
            if let Some(t) = target_bytes {
                let total = (t as f64 * 8.0 / 1000.0 / duration) as u32;
                audio_kbps = if total > 2000 { 128 } else if total > 600 { 96 } else { 64 };
                let v = total.saturating_sub(audio_kbps);
                if v < 120 {
                    let need = ((120 + audio_kbps) as f64 * duration / 8.0 / 1000.0 / 0.97).ceil();
                    bail!("This video is too long for that size. It needs at least {need:.0} MB.");
                }
                video_kbps = Some(v);
            }
            let final_path = paths::unique_path(dir, &out_stem, "mp4");
            let part = paths::part_path(&final_path);
            let plan = av::compress_video(st, &media, &caps, video_kbps, audio_kbps, "pass")?;
            let input_s = input.to_string_lossy().into_owned();
            let mut args = vec!["-i".to_string(), input_s.clone()];
            args.extend(plan.args.clone());
            args.push(part.to_string_lossy().into_owned());
            let guard = Part { path: part.clone(), done: false };
            if let Some(first) = plan.first_pass {
                let mut a1 = vec!["-i".to_string(), input_s];
                a1.extend(first);
                tools::run_ffmpeg(&a1, Some(duration), Some(&scratch.0), cancel, |p| prog(p * 0.45)).await?;
                tools::run_ffmpeg(&args, Some(duration), Some(&scratch.0), cancel, |p| prog(0.45 + p * 0.55)).await?;
            } else {
                tools::run_ffmpeg(&args, Some(duration), Some(&scratch.0), cancel, prog).await?;
            }
            std::mem::forget(guard);
            (part, final_path)
        }
        Kind::Audio => {
            let media = av::probe(input).await;
            let duration = media.duration.unwrap_or(0.0);
            let target_kbps = target_bytes.and_then(|t| (duration > 0.0).then(|| (t as f64 * 8.0 / 1000.0 / duration) as u32));
            let (a, ext) = av::compress_audio(st, &media, &in_ext, target_kbps)?;
            let final_path = paths::unique_path(dir, &out_stem, ext);
            let part = paths::part_path(&final_path);
            let mut args = vec!["-i".to_string(), input.to_string_lossy().into_owned()];
            args.extend(a);
            args.push(part.to_string_lossy().into_owned());
            let guard = Part { path: part.clone(), done: false };
            tools::run_ffmpeg(&args, media.duration, None, cancel, prog).await?;
            std::mem::forget(guard);
            (part, final_path)
        }
        Kind::Image if in_ext == "gif" && st.image_format.as_deref().unwrap_or("keep") == "keep" => {
            // Animated GIF: fewer colours and a smarter palette, through ffmpeg.
            let colors = match level { Level::Light => 256, Level::Balanced => 128, Level::Strong => 64 };
            let final_path = paths::unique_path(dir, &out_stem, "gif");
            let part = paths::part_path(&final_path);
            let vf = format!("split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle");
            let args = vec!["-i".into(), input.to_string_lossy().into_owned(), "-vf".into(), vf, "-loop".into(), "0".into(), part.to_string_lossy().into_owned()];
            let guard = Part { path: part.clone(), done: false };
            tools::run_ffmpeg(&args, None, None, cancel, prog).await?;
            std::mem::forget(guard);
            (part, final_path)
        }
        Kind::Image => {
            prog(0.05);
            let picture = load_image(input, &scratch.0, cancel).await?;
            let fmt = img::compress_format(st.image_format.as_deref().unwrap_or("keep"), &in_ext, picture.color().has_alpha());
            let final_path = paths::unique_path(dir, &out_stem, fmt.ext());
            let part = paths::part_path(&final_path);
            let guard = Part { path: part.clone(), done: false };
            prog(0.2);
            let base_q = img::level_quality(fmt, level);
            let picture = img::fit(picture, img::level_max_side(level));

            if fmt == OutFmt::Avif {
                encode_avif(picture, base_q, &part, &scratch.0, cancel).await?;
            } else {
                let c = cancel.clone();
                let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
                    let first = img::compress_once(&picture, fmt, level, base_q, &c)?.unwrap();
                    let Some(target) = target_bytes else { return Ok(first) };
                    if (first.len() as u64) <= target {
                        return Ok(first);
                    }
                    // Fit to size: lower quality first (binary search), then shrink the picture.
                    let mut pic = picture;
                    for _ in 0..6 {
                        if fmt != OutFmt::Png {
                            let (mut lo, mut hi, mut best) = (25u8, base_q, None::<Vec<u8>>);
                            while lo <= hi {
                                c.check()?;
                                let mid = (lo + hi) / 2;
                                let b = img::compress_once(&pic, fmt, level, mid, &c)?.unwrap();
                                if (b.len() as u64) <= target {
                                    best = Some(b);
                                    lo = mid + 1;
                                } else {
                                    if mid == 0 {
                                        break;
                                    }
                                    hi = mid - 1;
                                }
                            }
                            if let Some(b) = best {
                                return Ok(b);
                            }
                        } else {
                            let b = img::compress_once(&pic, fmt, Level::Strong, 0, &c)?.unwrap();
                            if (b.len() as u64) <= target {
                                return Ok(b);
                            }
                        }
                        let (w, h) = (pic.width(), pic.height());
                        let scale = 0.8;
                        pic = pic.resize(((w as f64) * scale) as u32, ((h as f64) * scale) as u32, image::imageops::FilterType::Lanczos3);
                    }
                    bail!("Couldn't get this image under that size.")
                })
                .await??;
                std::fs::write(&part, bytes)?;
            }
            std::mem::forget(guard);
            (part, final_path)
        }
        Kind::Pdf => {
            let final_path = paths::unique_path(dir, &out_stem, "pdf");
            let part = paths::part_path(&final_path);
            let guard = Part { path: part.clone(), done: false };
            let levels: Vec<Level> = if target_bytes.is_some() { vec![level, Level::Strong] } else { vec![level] };
            for (i, lv) in levels.iter().enumerate() {
                let (inp, outp, c, strip) = (input.to_path_buf(), part.clone(), cancel.clone(), st.strip_metadata.unwrap_or(true));
                let lv = *lv;
                tauri::async_runtime::spawn_blocking(move || pdf::compress(&inp, &outp, lv, strip, &c, &|_| {})).await??;
                prog((i + 1) as f64 / levels.len() as f64 * 0.95);
                let size = std::fs::metadata(&part)?.len();
                if target_bytes.map_or(true, |t| size <= t) {
                    break;
                }
            }
            std::mem::forget(guard);
            (part, final_path)
        }
        _ => bail!("Morf can't compress this kind of file yet."),
    };

    let mut guard = Part { path: part_path.clone(), done: false };
    cancel.check()?;
    let size = std::fs::metadata(&part_path)?.len();
    if let Some(t) = target_bytes {
        if size > t {
            bail!("Got it down to {}, but not under the limit. Try a lower resolution under Advanced.", human(size));
        }
    }
    // A copy that isn't smaller helps nobody.
    if size >= info.size {
        return Ok(Outcome { output: None, out_size: info.size, fallback, note: Some("Already as small as it gets; no copy made.".into()) });
    }
    let out = paths::commit(&part_path, &final_path)?;
    guard.done = true;
    Ok(Outcome { output: Some(out), out_size: size, fallback, note: None })
}

fn human(b: u64) -> String {
    if b >= 1_000_000 { format!("{:.1} MB", b as f64 / 1e6) } else { format!("{} KB", b / 1000) }
}
