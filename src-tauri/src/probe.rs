//! What a file is. The name is a hint; the first bytes decide, so a song renamed to `.jpg` gets a
//! sentence about that instead of a decoder's error.

use std::io::Read;
use std::path::Path;

use serde::Serialize;


#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Audio,
    Video,
    Image,
    Pdf,
    Document,
    Font,
    Unknown,
}

impl Kind {
    fn noun(self) -> &'static str {
        match self {
            Kind::Audio => "audio",
            Kind::Video => "a video",
            Kind::Image => "an image",
            Kind::Pdf => "a PDF",
            Kind::Document => "a document",
            Kind::Font => "a font",
            Kind::Unknown => "something else",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

pub fn kind_from_ext(ext: &str) -> Kind {
    match ext {
        "mp3" | "wav" | "opus" | "flac" | "m4a" | "aac" | "ogg" | "oga" | "wma" | "aiff" | "aif" | "aifc" | "alac" | "ac3" | "eac3" | "wv" | "mp2" | "amr" | "caf" | "ape" | "mka" | "dts" => Kind::Audio,
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" | "wmv" | "flv" | "mpg" | "mpeg" | "3gp" | "mts" | "m2ts" | "ts" | "ogv" | "vob" | "mxf" => Kind::Video,
        "jpg" | "jpeg" | "jfif" | "png" | "webp" | "heic" | "heif" | "avif" | "tif" | "tiff" | "gif" | "bmp" | "ico" | "tga" | "dng" | "cr2" | "cr3" | "nef" | "arw" | "raf" | "orf" | "rw2" => Kind::Image,
        "pdf" => Kind::Pdf,
        "docx" | "doc" | "odt" | "rtf" | "txt" | "md" | "markdown" | "html" | "htm" => Kind::Document,
        "ttf" | "otf" | "ttc" | "woff" | "woff2" => Kind::Font,
        _ => Kind::Unknown,
    }
}

/// The kind the first bytes say, when they say something definite.
pub fn sniff(head: &[u8]) -> Option<Kind> {
    let starts = |sig: &[u8]| head.starts_with(sig);
    let at = |off: usize, sig: &[u8]| head.len() >= off + sig.len() && &head[off..off + sig.len()] == sig;
    if starts(&[0xFF, 0xD8, 0xFF]) || starts(b"\x89PNG") || starts(b"GIF8") || starts(b"BM") || starts(b"II*\0") || starts(b"MM\0*") || (starts(b"RIFF") && at(8, b"WEBP")) || starts(&[0, 0, 1, 0]) {
        return Some(Kind::Image);
    }
    if starts(b"%PDF") {
        return Some(Kind::Pdf);
    }
    if starts(b"RIFF") && at(8, b"WAVE") || starts(b"fLaC") || starts(b"ID3") || starts(b"FORM") || starts(b"wvpk") || starts(b"caff") || starts(b"#!AMR") {
        return Some(Kind::Audio);
    }
    // MP3 frame sync (no ID3 tag).
    if head.len() > 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0 && (head[1] & 0x06) != 0 {
        return Some(Kind::Audio);
    }
    if starts(b"RIFF") && at(8, b"AVI ") {
        return Some(Kind::Video);
    }
    if starts(b"wOFF") || starts(b"wOF2") || starts(b"OTTO") || starts(&[0, 1, 0, 0]) || starts(b"ttcf") {
        return Some(Kind::Font);
    }
    // ISO media: the brand tells images (heic, avif) from audio (M4A) and video.
    if at(4, b"ftyp") && head.len() >= 12 {
        let brand = &head[8..12];
        return Some(match brand {
            b"heic" | b"heix" | b"mif1" | b"msf1" | b"heim" | b"heis" | b"avif" | b"avis" => Kind::Image,
            b"M4A " | b"M4B " | b"F4A " => Kind::Audio,
            _ => Kind::Video,
        });
    }
    // Ogg, Matroska and transport streams hold audio or video; the name decides between the two.
    None
}

pub async fn inspect(path_str: &str) -> FileInfo {
    let path = Path::new(path_str);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(path_str).to_string();
    let ext = crate::paths::ext_of(path);
    let mut info = FileInfo { path: path_str.to_string(), name, ext: ext.clone(), size: 0, kind: Kind::Unknown, duration: None, width: None, height: None, problem: None };

    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => {
            info.problem = Some("Morf can't open this file.".into());
            return info;
        }
    };
    if meta.is_dir() {
        info.problem = Some("This is a folder. Drop the files inside it instead.".into());
        return info;
    }
    info.size = meta.len();
    if info.size == 0 {
        info.problem = Some("This file is empty.".into());
        return info;
    }

    let mut head = [0u8; 64];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let by_name = kind_from_ext(&ext);
    let by_bytes = sniff(&head[..n]);

    info.kind = match (by_name, by_bytes) {
        // `.ts` is TypeScript as often as it is video: the bytes decide (MPEG-TS starts with 0x47).
        (Kind::Video, None) if ext == "ts" && head[0] != 0x47 => {
            info.problem = Some("This .ts file is TypeScript code, not a video.".into());
            Kind::Unknown
        }
        // Audio and video share containers; ffmpeg settles which one below.
        (named, Some(real)) if named != Kind::Unknown && named != real && !matches!((named, real), (Kind::Audio, Kind::Video) | (Kind::Video, Kind::Audio)) => {
            info.problem = Some(format!("This file is {}, not {}. Its name ends in .{ext}; rename it and try again.", real.noun(), named.noun()));
            real
        }
        (Kind::Unknown, Some(real)) => real,
        (named, _) => named,
    };

    match info.kind {
        Kind::Audio | Kind::Video => {
            let m = crate::av::probe(path).await;
            info.duration = m.duration;
            info.width = (m.width > 0).then_some(m.width);
            info.height = (m.height > 0).then_some(m.height);
            // An .mp4 with only sound is audio; an .ogg/.mkv with pictures is video.
            if info.kind == Kind::Video && !m.has_video && m.duration.is_some() {
                info.kind = Kind::Audio;
            } else if info.kind == Kind::Audio && m.has_video && matches!(ext.as_str(), "ogg" | "mka" | "m4a") {
                info.kind = Kind::Video;
            }
        }
        Kind::Image => {
            if let Ok((w, h)) = image::image_dimensions(path) {
                info.width = Some(w);
                info.height = Some(h);
            }
        }
        Kind::Unknown if info.problem.is_none() => {
            info.problem = Some(if ext.is_empty() { "Morf can't tell what this file is.".into() } else { format!("Morf doesn't work with .{ext} files yet.") });
        }
        _ => {}
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"), Some(Kind::Image));
        assert_eq!(sniff(b"ID3\x04"), Some(Kind::Audio));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic"), Some(Kind::Image));
        assert_eq!(sniff(b"\0\0\0\x18ftypM4A "), Some(Kind::Audio));
        assert_eq!(sniff(b"\0\0\0\x18ftypisom"), Some(Kind::Video));
        assert_eq!(sniff(b"%PDF-1.7"), Some(Kind::Pdf));
        assert_eq!(sniff(b"hello world"), None);
    }
}
