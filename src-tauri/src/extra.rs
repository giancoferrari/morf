//! Small engine pieces for the lighter tools (Resize, Rename, Compare, QR, Palette, Read, Cutout):
//! previews any image the window can't show, reads and writes files safely, renames in batches,
//! and applies Cutout's mask at full resolution.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine;
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths;

fn b64(s: &str) -> Result<Vec<u8>> {
    let s = s.split_once(',').map(|(_, d)| d).unwrap_or(s);
    Ok(base64::engine::general_purpose::STANDARD.decode(s)?)
}

/// A path the window can display: the original when the webview reads it, otherwise a PNG made
/// in the temp folder (HEIC, TIFF, camera RAW, AVIF through ffmpeg when needed).
pub async fn image_preview(path: &str) -> Result<String> {
    let p = Path::new(path);
    let ext = paths::ext_of(p);
    if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "svg" | "avif" | "ico") {
        return Ok(path.to_string());
    }
    let dir = std::env::temp_dir().join("morf-previews");
    std::fs::create_dir_all(&dir)?;
    let hash = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(path.as_bytes());
        if let Ok(m) = std::fs::metadata(p) {
            h.update(m.len().to_le_bytes());
        }
        format!("{:x}", h.finalize())
    };
    let out = dir.join(format!("{}.png", &hash[..16]));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let img = load_any(p).await?;
    let o = out.clone();
    tauri::async_runtime::spawn_blocking(move || img.save_with_format(&o, image::ImageFormat::Png)).await??;
    Ok(out.to_string_lossy().into_owned())
}

/// Decodes any image Morf supports, falling back to ffmpeg for formats the image crate lacks.
pub async fn load_any(p: &Path) -> Result<DynamicImage> {
    let path = p.to_path_buf();
    if let Ok(Ok(img)) = tauri::async_runtime::spawn_blocking(move || crate::img::load(&path)).await {
        return Ok(img);
    }
    let tmp = std::env::temp_dir().join(format!("morf-decode-{}.png", std::process::id()));
    let ffmpeg = crate::tools::ffmpeg()?;
    let st = crate::tools::command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(p)
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&tmp)
        .status()
        .await?;
    if !st.success() {
        bail!("Morf can't read this image.");
    }
    let t = tmp.clone();
    let img = tauri::async_runtime::spawn_blocking(move || crate::img::load(&t)).await??;
    let _ = std::fs::remove_file(tmp);
    Ok(img)
}

pub fn read_text(path: &str) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > 20_000_000 {
        bail!("This file is too large to compare (over 20 MB).");
    }
    let bytes = std::fs::read(path)?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(e) => {
            let bytes = e.into_bytes();
            // UTF-16 with a byte-order mark (Notepad's "Unicode").
            if bytes.starts_with(&[0xFF, 0xFE]) {
                let u: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                return Ok(String::from_utf16_lossy(&u));
            }
            if bytes.iter().take(4096).filter(|b| **b == 0).count() > 8 {
                bail!("This doesn't look like a text file.");
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// Writes to a path the person picked in a save dialog (they've already agreed to replace it).
pub fn save_bytes(path: &str, data: &str) -> Result<()> {
    std::fs::write(path, b64(data)?)?;
    Ok(())
}

/// Saves next to `beside` as `stem suffix.ext`, never replacing anything; Downloads when the
/// folder is read-only. Returns the path used.
pub fn save_beside(beside: &str, suffix: &str, ext: &str, data: &str, text: bool) -> Result<String> {
    let input = Path::new(beside);
    let (dir, _) = paths::output_dir(input, None);
    let stem = format!("{}{}", paths::stem_of(input), suffix);
    let out = paths::unique_path(&dir, &stem, ext);
    let bytes = if text { data.as_bytes().to_vec() } else { b64(data)? };
    // Through a part file, so a failed write never leaves half a file under the real name.
    let part = paths::part_path(&out);
    if let Err(e) = std::fs::write(&part, bytes) {
        paths::discard(&part);
        return Err(e.into());
    }
    Ok(paths::commit(&part, &out)?.to_string_lossy().into_owned())
}

/// Makes a new folder next to `beside`, named `stem suffix` (numbered if taken), for tools that
/// write many files at once (PDF split). Returns its path.
pub fn folder_beside(beside: &str, suffix: &str) -> Result<String> {
    let input = Path::new(beside);
    let (dir, _) = paths::output_dir(input, None);
    let stem = format!("{}{}", paths::stem_of(input), suffix);
    let mut n = 1;
    loop {
        let name = if n == 1 { stem.clone() } else { format!("{stem} {n}") };
        let candidate = dir.join(name);
        if !candidate.exists() {
            std::fs::create_dir(&candidate)?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
        n += 1;
    }
}

/* ------------------------------------------------------------------------------------------------
 * Rename
 * ----------------------------------------------------------------------------------------------*/

#[derive(Deserialize)]
pub struct RenamePair {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub from: String,
    pub to: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Renames in two passes through temporary names, so swaps (a→b, b→a) and case-only changes
/// work, and nothing that isn't part of the batch is ever replaced.
pub fn rename_files(pairs: Vec<RenamePair>) -> Vec<RenameResult> {
    let sources: std::collections::HashSet<String> = pairs.iter().map(|p| p.from.to_lowercase()).collect();
    let mut staged: Vec<(RenamePair, Option<PathBuf>, Option<String>)> = vec![];
    for p in pairs {
        let to = Path::new(&p.to);
        let name_ok = to.file_name().and_then(|n| n.to_str()).map(|n| !n.trim().is_empty() && !n.contains(['<', '>', ':', '"', '|', '?', '*'])).unwrap_or(false);
        if !name_ok {
            staged.push((p, None, Some("That name isn't allowed.".into())));
            continue;
        }
        if p.from == p.to {
            staged.push((p, None, None));
            continue;
        }
        if to.exists() && !sources.contains(&p.to.to_lowercase()) {
            staged.push((p, None, Some("A file with that name already exists.".into())));
            continue;
        }
        let tmp = Path::new(&p.from).with_file_name(format!(".morf-rename-{}-{}", std::process::id(), staged.len()));
        match std::fs::rename(&p.from, &tmp) {
            Ok(()) => staged.push((p, Some(tmp), None)),
            Err(e) => staged.push((p, None, Some(e.to_string()))),
        }
    }
    staged
        .into_iter()
        .map(|(p, tmp, err)| match (tmp, err) {
            (_, Some(e)) => RenameResult { from: p.from, to: p.to, ok: false, error: Some(e) },
            (None, None) => RenameResult { from: p.from, to: p.to, ok: true, error: None },
            (Some(tmp), None) => match std::fs::rename(&tmp, &p.to) {
                Ok(()) => RenameResult { from: p.from, to: p.to, ok: true, error: None },
                Err(e) => {
                    let _ = std::fs::rename(&tmp, &p.from);
                    RenameResult { from: p.from, to: p.to, ok: false, error: Some(e.to_string()) }
                }
            },
        })
        .collect()
}

/* ------------------------------------------------------------------------------------------------
 * Cutout
 * ----------------------------------------------------------------------------------------------*/

pub const CUTOUT_MODEL: (&str, &str, u64, &str) = (
    "isnet-general-use.onnx",
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
    178_648_008,
    "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
);

pub fn cutout_model_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(crate::dictate::models_dir(app)?.join(CUTOUT_MODEL.0))
}

/// Puts the model's mask (any size, greyscale PNG) on the original picture at full resolution and
/// saves `name (cutout).png` beside it. `crop` trims the empty border.
pub async fn apply_cutout(path: &str, mask_png: &str, crop: bool) -> Result<String> {
    let original = load_any(Path::new(path)).await?;
    let mask = image::load_from_memory(&b64(mask_png)?)?.to_luma8();
    let p = path.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let (w, h) = original.dimensions();
        let mask = image::imageops::resize(&mask, w, h, image::imageops::FilterType::Triangle);
        let mut rgba = original.to_rgba8();
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            let a = mask.get_pixel(x, y)[0] as u16;
            px[3] = ((px[3] as u16 * a) / 255) as u8;
        }
        let mut out = DynamicImage::ImageRgba8(rgba);
        if crop {
            let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
            for (x, y, px) in out.as_rgba8().unwrap().enumerate_pixels() {
                if px[3] > 8 {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
            if x1 > x0 && y1 > y0 {
                out = out.crop_imm(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
            }
        }
        let bytes = crate::img::encode_png(&out, 2)?;
        let input = Path::new(&p);
        let (dir, _) = paths::output_dir(input, None);
        let dest = paths::unique_path(&dir, &format!("{} (cutout)", paths::stem_of(input)), "png");
        std::fs::write(&dest, bytes).context("Couldn't save the cutout")?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await?
}

/* ------------------------------------------------------------------------------------------------
 * Storage: what Morf keeps on disk, for Settings
 * ----------------------------------------------------------------------------------------------*/

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredModel {
    pub id: String,
    pub name: String,
    /// "speech" (Dictate) or "cutout".
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub models: Vec<StoredModel>,
    /// Converted previews of HEIC, TIFF and RAW pictures.
    pub previews: u64,
    pub data_dir: String,
}

fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

fn previews_dir() -> PathBuf {
    std::env::temp_dir().join("morf-previews")
}

pub fn storage(app: &AppHandle) -> Result<Storage> {
    use tauri::Manager;
    let mut models: Vec<StoredModel> = crate::dictate::downloaded_models(app)
        .into_iter()
        .map(|(id, name, size)| StoredModel { id: id.into(), name: name.into(), kind: "speech", size })
        .collect();
    if let Ok(p) = cutout_model_path(app) {
        if let Ok(m) = std::fs::metadata(&p) {
            models.push(StoredModel { id: "cutout".into(), name: "Cutout (ISNet)".into(), kind: "cutout", size: m.len() });
        }
    }
    Ok(Storage { models, previews: dir_size(&previews_dir()), data_dir: app.path().app_data_dir()?.to_string_lossy().into_owned() })
}

pub fn clear_previews() -> Result<()> {
    let dir = previews_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

pub fn delete_cutout_model(app: &AppHandle) -> Result<()> {
    let p = cutout_model_path(app)?;
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_swap_and_refuse_overwrites() {
        let dir = std::env::temp_dir().join(format!("morf-rename-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        std::fs::write(p("a.txt"), "A").unwrap();
        std::fs::write(p("b.txt"), "B").unwrap();
        std::fs::write(p("keep.txt"), "K").unwrap();
        // Swap a and b in one batch.
        let r = rename_files(vec![RenamePair { from: p("a.txt"), to: p("b.txt") }, RenamePair { from: p("b.txt"), to: p("a.txt") }]);
        assert!(r.iter().all(|x| x.ok), "{:?}", r.iter().map(|x| &x.error).collect::<Vec<_>>());
        assert_eq!(std::fs::read_to_string(p("a.txt")).unwrap(), "B");
        assert_eq!(std::fs::read_to_string(p("b.txt")).unwrap(), "A");
        // Never replaces a file outside the batch.
        let r = rename_files(vec![RenamePair { from: p("a.txt"), to: p("keep.txt") }]);
        assert!(!r[0].ok);
        assert_eq!(std::fs::read_to_string(p("keep.txt")).unwrap(), "K");
        // Case-only change works on case-insensitive disks.
        let r = rename_files(vec![RenamePair { from: p("a.txt"), to: p("A2.txt") }]);
        assert!(r[0].ok);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
