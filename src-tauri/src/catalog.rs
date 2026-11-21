//! Every output format Morf offers. A format whose encoder this ffmpeg lacks is left out rather
//! than offered and failing.

use serde::Serialize;

use crate::probe::Kind;
use crate::tools::Capabilities;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<&'static str>,
    pub ext: &'static str,
    pub group: &'static str,
    pub accepts: Vec<Kind>,
    pub options: Vec<&'static str>,
    pub lossless: bool,
}

const AUDIO_OPTS: &[&str] = &["bitrate", "sampleRate", "channels"];
const LOSSLESS_OPTS: &[&str] = &["sampleRate", "channels", "bitDepth"];
const VIDEO_OPTS: &[&str] = &["quality", "resolution", "fps", "keepAudio", "hardware"];

fn t(id: &'static str, label: &'static str, detail: Option<&'static str>, ext: &'static str, group: &'static str, accepts: &[Kind], options: &[&'static str], lossless: bool) -> Target {
    Target { id, label, detail, ext, group, accepts: accepts.to_vec(), options: options.to_vec(), lossless }
}

pub fn all() -> Vec<Target> {
    use Kind::*;
    let av = &[Audio, Video];
    let img = &[Image];
    vec![
        t("mp4-h264", "MP4", Some("H.264"), "mp4", "video", &[Video], VIDEO_OPTS, false),
        t("mp4-hevc", "MP4", Some("HEVC"), "mp4", "video", &[Video], VIDEO_OPTS, false),
        t("mp4-av1", "MP4", Some("AV1"), "mp4", "video", &[Video], &["quality", "resolution", "fps", "keepAudio"], false),
        t("mov-prores", "MOV", Some("ProRes 422"), "mov", "video", &[Video], &["resolution", "fps", "keepAudio"], false),
        t("webm-vp9", "WebM", Some("VP9"), "webm", "video", &[Video], &["quality", "resolution", "fps", "keepAudio"], false),
        t("mkv", "MKV", Some("H.264"), "mkv", "video", &[Video], VIDEO_OPTS, false),
        t("gif", "GIF", Some("Animated"), "gif", "video", &[Video], &["gifWidth", "gifFps"], false),
        t("mp3", "MP3", None, "mp3", "audio", av, AUDIO_OPTS, false),
        t("m4a-aac", "M4A", Some("AAC"), "m4a", "audio", av, AUDIO_OPTS, false),
        t("m4a-heaac", "M4A", Some("HE-AAC"), "m4a", "audio", av, AUDIO_OPTS, false),
        t("wav", "WAV", None, "wav", "audio", av, LOSSLESS_OPTS, true),
        t("aiff", "AIFF", None, "aiff", "audio", av, LOSSLESS_OPTS, true),
        t("flac", "FLAC", None, "flac", "audio", av, LOSSLESS_OPTS, true),
        t("alac", "ALAC", None, "m4a", "audio", av, LOSSLESS_OPTS, true),
        t("opus", "Opus", None, "opus", "audio", av, AUDIO_OPTS, false),
        t("ogg", "OGG", Some("Vorbis"), "ogg", "audio", av, AUDIO_OPTS, false),
        t("wma", "WMA", None, "wma", "audio", av, AUDIO_OPTS, false),
        t("ac3", "AC3", None, "ac3", "audio", av, AUDIO_OPTS, false),
        t("wavpack", "WavPack", None, "wv", "audio", av, LOSSLESS_OPTS, true),
        t("mp2", "MP2", None, "mp2", "audio", av, AUDIO_OPTS, false),
        t("jpeg", "JPEG", None, "jpg", "image", img, &["imageQuality", "maxSize"], false),
        t("png", "PNG", None, "png", "image", img, &["maxSize"], true),
        t("webp", "WebP", None, "webp", "image", img, &["imageQuality", "maxSize"], false),
        t("avif", "AVIF", None, "avif", "image", img, &["imageQuality", "maxSize"], false),
        t("tiff", "TIFF", None, "tiff", "image", img, &["maxSize"], true),
        t("gif-image", "GIF", None, "gif", "image", img, &["maxSize"], false),
        t("bmp", "BMP", None, "bmp", "image", img, &["maxSize"], true),
        t("ico", "ICO", Some("Icon"), "ico", "image", img, &[], true),
        t("pdf-image", "PDF", None, "pdf", "image", img, &["imageQuality", "maxSize"], false),
    ]
}

/// The formats this computer can actually make. Without ffmpeg, only image formats remain.
pub fn available(caps: Option<&Capabilities>) -> Vec<Target> {
    all()
        .into_iter()
        .filter(|t| {
            let Some(c) = caps else { return t.group == "image" && t.id != "avif" };
            match t.id {
                "mp4-h264" | "mkv" => c.has("libx264") || c.hw_h264.is_some(),
                "mp4-hevc" => c.has("libx265") || c.hw_hevc.is_some(),
                "mp4-av1" => c.has("libsvtav1") || c.has("libaom-av1"),
                "webm-vp9" => c.has("libvpx-vp9"),
                "mp3" => c.has("libmp3lame"),
                "m4a-heaac" => c.has("libfdk_aac"),
                "opus" => c.has("libopus"),
                "ogg" => c.has("libvorbis") || c.has("vorbis"),
                "avif" => c.has("libaom-av1") || c.has("libsvtav1"),
                _ => true,
            }
        })
        .collect()
}

pub fn find(id: &str) -> Option<Target> {
    all().into_iter().find(|t| t.id == id)
}
