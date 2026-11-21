//! Audio and video through ffmpeg: the arguments for every format, and compression.
//! Conversion arguments follow Convert's (MIT), which were tuned per encoder.

use std::path::Path;

use anyhow::{anyhow, bail, Result};

use crate::jobs::{Settings, Level};
use crate::tools::{self, Capabilities};

#[derive(Default, Debug, Clone)]
pub struct Media {
    pub duration: Option<f64>,
    pub sample_rate: u32,
    pub hi_res: bool,
    pub has_audio: bool,
    pub has_video: bool,
    pub width: u32,
    pub height: u32,
    pub audio_bitrate: Option<u32>,
}

/// Reads what's inside a media file from `ffmpeg -i`, which prints the container's duration and
/// one line per stream. (Morf bundles ffmpeg only; ffprobe would double the download.)
pub async fn probe(path: &Path) -> Media {
    let Ok(ffmpeg) = tools::ffmpeg() else { return Media::default() };
    let Ok(out) = tools::command(&ffmpeg).args(["-hide_banner", "-nostdin", "-i"]).arg(path).output().await else {
        return Media::default();
    };
    parse_probe(&String::from_utf8_lossy(&out.stderr))
}

pub fn parse_probe(text: &str) -> Media {
    let mut m = Media::default();
    if let Some(rest) = text.split("Duration: ").nth(1) {
        let t = rest.split(',').next().unwrap_or("").trim();
        let parts: Vec<f64> = t.split(':').filter_map(|p| p.parse().ok()).collect();
        if parts.len() == 3 {
            m.duration = Some(parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]);
        }
    }
    for line in text.lines().map(str::trim).filter(|l| l.starts_with("Stream #")) {
        if line.contains(": Video:") && !line.contains("(attached pic)") && !m.has_video {
            m.has_video = true;
            for token in line.split([' ', ',']) {
                if let Some((w, h)) = token.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if w > 0 && h > 0 && !token.starts_with('0') {
                            m.width = w;
                            m.height = h;
                            break;
                        }
                    }
                }
            }
        } else if line.contains(": Audio:") && !m.has_audio {
            m.has_audio = true;
            let fields: Vec<&str> = line.split(", ").map(str::trim).collect();
            for f in &fields {
                if let Some(hz) = f.strip_suffix(" Hz") {
                    m.sample_rate = hz.trim().parse().unwrap_or(0);
                } else if let Some((kb, _)) = f.split_once(" kb/s") {
                    // "128 kb/s (default)": the number right before the unit.
                    m.audio_bitrate = kb.split_whitespace().last().and_then(|v| v.parse().ok());
                }
            }
            m.hi_res = fields.iter().any(|f| f.starts_with("s32") || f.starts_with("s24") || f.contains("(24 bit)") || f.starts_with("flt") && line.contains("pcm_f"));
        }
    }
    m
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    #[test]
    fn reads_ffmpeg_banner() {
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:03:04.12, start: 0.000000, bitrate: 2105 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1970 kb/s, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
";
        let m = parse_probe(text);
        assert!((m.duration.unwrap() - 184.12).abs() < 0.01);
        assert_eq!((m.width, m.height), (1920, 1080));
        assert!(m.has_audio && m.has_video);
        assert_eq!(m.sample_rate, 48000);
        assert_eq!(m.audio_bitrate, Some(128));
    }

    #[test]
    fn cover_art_is_not_video() {
        let text = "  Duration: 00:00:10.00, start: 0
  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 600x600, 90k tbr (attached pic)
";
        let m = parse_probe(text);
        assert!(m.has_audio && !m.has_video && m.hi_res);
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn vorbis_quality(kbps: u32) -> &'static str {
    match kbps {
        320.. => "9",
        256.. => "8",
        192.. => "6",
        160.. => "5",
        128.. => "4",
        _ => "2",
    }
}

fn default_bitrate(id: &str) -> u32 {
    match id {
        "opus" => 160,
        "m4a-heaac" => 64,
        "wma" | "mp2" | "ac3" => 192,
        _ => 256,
    }
}

/// Arguments after `-i input` for an audio target.
pub fn audio_args(id: &str, st: &Settings, m: &Media, caps: &Capabilities) -> Vec<String> {
    let mut a = s(&["-map", "0:a:0", "-vn", "-map_metadata", "0", "-map_metadata", "0:s:a:0"]);
    let auto = st.bitrate.as_deref().map_or(true, |b| b == "auto");
    let br: u32 = if auto { default_bitrate(id) } else { st.bitrate.as_deref().and_then(|b| b.parse().ok()).unwrap_or(default_bitrate(id)) };
    let deep = match st.bit_depth.as_deref() {
        Some("24") => true,
        Some("16") => false,
        _ => m.hi_res,
    };
    let mut cap48 = matches!(id, "m4a-aac" | "m4a-heaac" | "ogg" | "wma" | "ac3" | "mp2" | "mp3");
    let kb = format!("{br}k");
    match id {
        "mp3" => {
            a.extend(s(&["-c:a", "libmp3lame"]));
            if auto { a.extend(s(&["-q:a", "0"])) } else { a.extend(["-b:a".into(), kb]) }
            a.extend(s(&["-id3v2_version", "3"]));
        }
        "m4a-aac" => a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), kb]),
        "m4a-heaac" => a.extend(["-c:a".into(), "libfdk_aac".into(), "-profile:a".into(), "aac_he".into(), "-b:a".into(), kb]),
        "opus" => {
            a.extend(["-c:a".into(), "libopus".into(), "-b:a".into(), kb]);
            cap48 = false;
        }
        "ogg" => {
            if caps.has("libvorbis") {
                a.extend(s(&["-c:a", "libvorbis", "-q:a", vorbis_quality(br)]));
            } else {
                a.extend(s(&["-c:a", "vorbis", "-strict", "experimental", "-ac", "2", "-q:a", vorbis_quality(br)]));
            }
        }
        "wma" => a.extend(["-c:a".into(), "wmav2".into(), "-b:a".into(), kb]),
        "ac3" => a.extend(["-c:a".into(), "ac3".into(), "-b:a".into(), kb]),
        "mp2" => a.extend(["-c:a".into(), "mp2".into(), "-b:a".into(), kb]),
        "wav" => a.extend(s(&["-c:a", if deep { "pcm_s24le" } else { "pcm_s16le" }])),
        "aiff" => a.extend(s(&["-c:a", if deep { "pcm_s24be" } else { "pcm_s16be" }])),
        "flac" => {
            a.extend(s(&["-c:a", "flac", "-compression_level", "8", "-sample_fmt", if deep { "s32" } else { "s16" }]));
            if deep {
                a.extend(s(&["-bits_per_raw_sample", "24"]));
            }
        }
        "alac" => {
            a.extend(s(&["-c:a", "alac", "-sample_fmt", if deep { "s32p" } else { "s16p" }]));
            if deep {
                a.extend(s(&["-bits_per_raw_sample", "24"]));
            }
        }
        "wavpack" => {
            a.extend(s(&["-c:a", "wavpack", "-sample_fmt", if deep { "s32p" } else { "s16p" }]));
            if deep {
                a.extend(s(&["-bits_per_raw_sample", "24"]));
            }
        }
        _ => {}
    }
    match st.sample_rate.as_deref() {
        Some(r) if r != "source" && r.parse::<u32>().is_ok() => a.extend(["-ar".into(), r.into()]),
        _ if cap48 && m.sample_rate > 48000 => a.extend(s(&["-ar", "48000"])),
        _ => {}
    }
    match st.channels.as_deref() {
        Some("mono") => a.extend(s(&["-ac", "1"])),
        Some("stereo") => a.extend(s(&["-ac", "2"])),
        _ => {}
    }
    a
}

/// Arguments after `-i input` for a video target.
pub fn video_args(id: &str, st: &Settings, m: &Media, caps: &Capabilities) -> Vec<String> {
    let q = (st.quality.unwrap_or(70) as f64 / 100.0).clamp(0.0, 1.0);
    let crf = |top: f64, range: f64| format!("{}", (top - q * range).round() as i32);
    let mut v = s(&["-map", "0:v:0", "-map_metadata", "0"]);

    if id == "gif" {
        let fps = st.gif_fps.clone().unwrap_or_else(|| "15".into());
        let width = st.gif_width.clone().unwrap_or_else(|| "480".into());
        let scale = if width == "source" { "scale=iw:-2:flags=lanczos".to_string() } else { format!("scale=min(iw\\,{width}):-2:flags=lanczos") };
        let vf = format!("fps={fps},{scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a");
        v.extend(["-vf".into(), vf, "-loop".into(), "0".into(), "-an".into()]);
        return v;
    }

    let mut filters: Vec<String> = vec![];
    if let Some(f) = st.fps.as_deref().filter(|f| *f != "source") {
        filters.push(format!("fps={f}"));
    }
    if let Some(h) = st.resolution.as_deref().filter(|h| *h != "source") {
        filters.push(format!("scale=-2:min(ih\\,{h})"));
    }
    let mut audio = s(&["-c:a", "aac", "-b:a", "192k"]);
    let hw = st.hardware.unwrap_or(true);
    let h264 = if hw { caps.hw_h264.clone() } else { None }.or_else(|| (!caps.has("libx264")).then(|| caps.hw_h264.clone()).flatten());
    let hevc = if hw { caps.hw_hevc.clone() } else { None }.or_else(|| (!caps.has("libx265")).then(|| caps.hw_hevc.clone()).flatten());

    match id {
        "mp4-h264" | "mkv" => v.extend(match h264.as_deref() {
            Some(e @ "h264_nvenc") => s(&["-c:v", e, "-preset", "p5", "-rc", "vbr", "-cq", &crf(32.0, 13.0), "-b:v", "0", "-pix_fmt", "yuv420p"]),
            Some(e @ "h264_qsv") => s(&["-c:v", e, "-preset", "medium", "-global_quality", &crf(32.0, 13.0)]),
            Some(e @ "h264_amf") => {
                let qp = crf(30.0, 12.0);
                s(&["-c:v", e, "-quality", "balanced", "-rc", "cqp", "-qp_i", &qp, "-qp_p", &qp, "-qp_b", &qp, "-pix_fmt", "yuv420p"])
            }
            Some(e @ "h264_videotoolbox") => s(&["-c:v", e, "-q:v", &format!("{}", (35.0 + q * 45.0).round() as i32), "-pix_fmt", "yuv420p"]),
            _ => s(&["-c:v", "libx264", "-preset", "medium", "-crf", &crf(30.0, 12.0), "-pix_fmt", "yuv420p"]),
        }),
        "mp4-hevc" => {
            v.extend(match hevc.as_deref() {
                Some(e @ "hevc_nvenc") => s(&["-c:v", e, "-preset", "p5", "-rc", "vbr", "-cq", &crf(34.0, 13.0), "-b:v", "0", "-pix_fmt", "yuv420p"]),
                Some(e @ "hevc_qsv") => s(&["-c:v", e, "-preset", "medium", "-global_quality", &crf(34.0, 13.0)]),
                Some(e @ "hevc_amf") => {
                    let qp = crf(32.0, 12.0);
                    s(&["-c:v", e, "-quality", "balanced", "-rc", "cqp", "-qp_i", &qp, "-qp_p", &qp, "-pix_fmt", "yuv420p"])
                }
                Some(e @ "hevc_videotoolbox") => s(&["-c:v", e, "-q:v", &format!("{}", (35.0 + q * 45.0).round() as i32), "-pix_fmt", "yuv420p"]),
                _ => s(&["-c:v", "libx265", "-preset", "medium", "-crf", &crf(32.0, 12.0), "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"]),
            });
            v.extend(s(&["-tag:v", "hvc1"]));
        }
        "mov-prores" => {
            let enc = if cfg!(target_os = "macos") && caps.has("prores_videotoolbox") && hw { "prores_videotoolbox" } else { "prores_ks" };
            v.extend(s(&["-c:v", enc, "-profile:v", "2", "-pix_fmt", "yuv422p10le"]));
            audio = s(&["-c:a", "pcm_s16le"]);
        }
        "webm-vp9" => {
            v.extend(s(&["-c:v", "libvpx-vp9", "-crf", &crf(42.0, 17.0), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4"]));
            audio = s(&["-c:a", "libopus", "-b:a", "128k"]);
        }
        "mp4-av1" => {
            if caps.has("libsvtav1") {
                v.extend(s(&["-c:v", "libsvtav1", "-crf", &crf(46.0, 20.0), "-preset", "8", "-pix_fmt", "yuv420p"]));
            } else {
                v.extend(s(&["-c:v", "libaom-av1", "-crf", &crf(46.0, 20.0), "-cpu-used", "6", "-row-mt", "1", "-pix_fmt", "yuv420p"]));
            }
        }
        _ => {}
    }
    if !filters.is_empty() {
        v.extend(["-vf".into(), filters.join(",")]);
    }
    if st.keep_audio.unwrap_or(true) && m.has_audio {
        let is_aac = audio[1] == "aac";
        v.extend(s(&["-map", "0:a:0"]));
        v.extend(audio);
        if is_aac && m.sample_rate > 48000 {
            v.extend(s(&["-ar", "48000"]));
        }
    } else {
        v.push("-an".into());
    }
    if id.starts_with("mp4") || id == "mov-prores" {
        v.extend(s(&["-movflags", "+faststart"]));
    }
    v
}

/* ------------------------------------------------------------------------------------------------
 * Compression
 * ----------------------------------------------------------------------------------------------*/

/// Plans one compression pass. `video_kbps` set means a size target: bitrate-driven two-pass.
pub struct VideoPlan {
    pub args: Vec<String>,
    /// For two-pass: the first pass's arguments (output goes to null).
    pub first_pass: Option<Vec<String>>,
}

pub fn compress_video(st: &Settings, m: &Media, caps: &Capabilities, video_kbps: Option<u32>, audio_kbps: u32, passlog: &str) -> Result<VideoPlan> {
    let level = st.level.unwrap_or(Level::Balanced);
    let codec = st.video_codec.as_deref().unwrap_or("h265");
    let mut filters: Vec<String> = vec![];
    if let Some(h) = st.max_dimension.as_deref().filter(|h| *h != "source").and_then(|h| h.parse::<u32>().ok()) {
        // Limit the short side, so portrait phone videos shrink the same as landscape ones.
        filters.push(format!("scale='if(gte(iw,ih),-2,min(iw,{h}))':'if(gte(iw,ih),min(ih,{h}),-2)':flags=lanczos"));
    }
    let mut base = s(&["-map", "0:v:0"]);
    if st.strip_metadata.unwrap_or(true) {
        base.extend(s(&["-map_metadata", "-1", "-map_chapters", "-1"]));
    } else {
        base.extend(s(&["-map_metadata", "0"]));
    }

    // Size targets always go through x264/x265 two-pass: AV1 encoders hit sizes less reliably.
    let codec = if video_kbps.is_some() && codec == "av1" { "h265" } else { codec };
    let (enc_args, _ext): (Vec<String>, &str) = match (codec, video_kbps) {
        ("h264", None) => {
            let crf = match level { Level::Light => "21", Level::Balanced => "24", Level::Strong => "28" };
            (s(&["-c:v", "libx264", "-preset", "slow", "-crf", crf, "-pix_fmt", "yuv420p"]), "mp4")
        }
        ("av1", None) if caps.has("libsvtav1") => {
            let crf = match level { Level::Light => "30", Level::Balanced => "36", Level::Strong => "42" };
            (s(&["-c:v", "libsvtav1", "-preset", "6", "-crf", crf, "-svtav1-params", "tune=0", "-pix_fmt", "yuv420p10le"]), "mp4")
        }
        ("av1", None) => {
            let crf = match level { Level::Light => "30", Level::Balanced => "36", Level::Strong => "42" };
            (s(&["-c:v", "libaom-av1", "-cpu-used", "5", "-row-mt", "1", "-crf", crf, "-pix_fmt", "yuv420p"]), "mp4")
        }
        ("h264", Some(kbps)) => (s(&["-c:v", "libx264", "-preset", "slow", "-b:v", &format!("{kbps}k"), "-pix_fmt", "yuv420p"]), "mp4"),
        (_, Some(kbps)) => (s(&["-c:v", "libx265", "-preset", "medium", "-b:v", &format!("{kbps}k"), "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]), "mp4"),
        _ => {
            let crf = match level { Level::Light => "23", Level::Balanced => "27", Level::Strong => "31" };
            (s(&["-c:v", "libx265", "-preset", "medium", "-crf", crf, "-tag:v", "hvc1", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"]), "mp4")
        }
    };
    let needs = |e: &str| enc_args.iter().any(|a| a == e);
    if needs("libx265") && !caps.has("libx265") || needs("libx264") && !caps.has("libx264") {
        bail!("This copy of ffmpeg can't encode {codec}. Choose another codec under Advanced.");
    }

    let mut args = base.clone();
    args.extend(enc_args.clone());
    if !filters.is_empty() {
        args.extend(["-vf".into(), filters.join(",")]);
    }
    let first_pass = video_kbps.map(|_| {
        let mut p = args.clone();
        // A bare file name: ffmpeg runs inside the temp folder, so no path needs escaping.
        let log = passlog.to_string();
        if needs("libx265") {
            p.extend(["-x265-params".into(), format!("pass=1:stats={log}:log-level=error")]);
        } else {
            p.extend(["-pass".into(), "1".into(), "-passlogfile".into(), log.clone()]);
        }
        p.extend(s(&["-an", "-f", "null"]));
        p.push(if cfg!(windows) { "NUL".into() } else { "/dev/null".into() });
        p
    });
    if video_kbps.is_some() {
        let log = passlog.to_string();
        if needs("libx265") {
            args.extend(["-x265-params".into(), format!("pass=2:stats={log}:log-level=error")]);
        } else {
            args.extend(["-pass".into(), "2".into(), "-passlogfile".into(), log]);
        }
    }
    if m.has_audio {
        args.extend(s(&["-map", "0:a:0", "-c:a", "aac", "-b:a", &format!("{audio_kbps}k")]));
        if m.sample_rate > 48000 {
            args.extend(s(&["-ar", "48000"]));
        }
    } else {
        args.push("-an".into());
    }
    args.extend(s(&["-movflags", "+faststart"]));
    Ok(VideoPlan { args, first_pass })
}

/// Audio compression: same family where it's lossy; lossless sources become FLAC (still lossless).
pub fn compress_audio(st: &Settings, m: &Media, input_ext: &str, target_kbps: Option<u32>) -> Result<(Vec<String>, &'static str)> {
    let level = st.level.unwrap_or(Level::Balanced);
    let choice = st.audio_format.as_deref().unwrap_or("keep");
    let family = match choice {
        "opus" => "opus",
        "aac" => "aac",
        "mp3" => "mp3",
        _ => match input_ext {
            "mp3" => "mp3",
            "m4a" | "aac" | "mp4" => "aac",
            "opus" | "ogg" | "oga" | "webm" => "opus",
            "wav" | "aiff" | "aif" | "flac" | "alac" | "wv" if target_kbps.is_none() && level == Level::Light => "flac",
            _ => "aac",
        },
    };
    let level_kbps = match (family, level) {
        ("opus", Level::Light) => 128,
        ("opus", Level::Balanced) => 96,
        ("opus", Level::Strong) => 64,
        (_, Level::Light) => 192,
        (_, Level::Balanced) => 128,
        (_, Level::Strong) => 96,
    };
    // Never raise the bitrate above what the source already has.
    let mut kbps = target_kbps.unwrap_or(level_kbps);
    if let Some(src) = m.audio_bitrate.filter(|b| *b > 0) {
        kbps = kbps.min(src.saturating_sub(8).max(32));
    }
    let mut a = s(&["-map", "0:a:0", "-vn"]);
    if st.strip_metadata.unwrap_or(true) {
        a.extend(s(&["-map_metadata", "-1"]));
    } else {
        a.extend(s(&["-map_metadata", "0"]));
    }
    let kb = format!("{kbps}k");
    let ext = match family {
        "opus" => {
            a.extend(["-c:a".into(), "libopus".into(), "-b:a".into(), kb]);
            "opus"
        }
        "mp3" => {
            a.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), kb]);
            "mp3"
        }
        "flac" => {
            a.extend(s(&["-c:a", "flac", "-compression_level", "12"]));
            "flac"
        }
        _ => {
            a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), kb]);
            "m4a"
        }
    };
    if family != "flac" && family != "opus" && m.sample_rate > 48000 {
        a.extend(s(&["-ar", "48000"]));
    }
    if target_kbps.is_some() && kbps < 24 {
        return Err(anyhow!("That size is too small for this recording. Try a larger limit."));
    }
    Ok((a, ext))
}
