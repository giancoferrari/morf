//! PDF compression. Almost all of a large PDF's weight is pictures (scans, photos), so each image
//! is decoded, scaled down to a sensible resolution and stored again as JPEG. Text, vectors and
//! fonts are untouched; streams are recompressed and unused objects dropped.

use std::path::Path;

use anyhow::{Context, Result};
use image::{DynamicImage, GenericImageView};
use lopdf::{Document, Object, ObjectId};

use crate::img;
use crate::jobs::Level;
use crate::tools::Cancel;

struct Plan {
    quality: u8,
    /// Longest side an embedded picture may keep, in pixels.
    max_side: u32,
}

fn plan(level: Level) -> Plan {
    match level {
        Level::Light => Plan { quality: 82, max_side: 3000 },
        Level::Balanced => Plan { quality: 70, max_side: 2000 },
        Level::Strong => Plan { quality: 55, max_side: 1400 },
    }
}

fn name(o: Option<&Object>) -> Option<String> {
    o.and_then(|o| o.as_name().ok()).map(|n| String::from_utf8_lossy(n).into_owned())
}

/// Decodes an image XObject we know how to rebuild: JPEGs, and plain 8-bit RGB or grey pixels.
/// Anything else (masks, indexed colour, CMYK, JBIG2, 16-bit) is left exactly as it was.
fn decode(stream: &lopdf::Stream) -> Option<DynamicImage> {
    let d = &stream.dict;
    if d.get(b"SMask").is_ok() || d.get(b"Mask").is_ok() || d.get(b"ImageMask").map(|m| m.as_bool().unwrap_or(false)).unwrap_or(false) {
        return None;
    }
    let width = d.get(b"Width").ok()?.as_i64().ok()? as u32;
    let height = d.get(b"Height").ok()?.as_i64().ok()? as u32;
    let bpc = d.get(b"BitsPerComponent").ok().and_then(|b| b.as_i64().ok()).unwrap_or(8);
    let cs = name(d.get(b"ColorSpace").ok());
    let filters: Vec<String> = match d.get(b"Filter").ok()? {
        Object::Name(n) => vec![String::from_utf8_lossy(n).into_owned()],
        Object::Array(a) => a.iter().filter_map(|o| o.as_name().ok()).map(|n| String::from_utf8_lossy(n).into_owned()).collect(),
        _ => return None,
    };
    match filters.as_slice() {
        [f] if f == "DCTDecode" => {
            if cs.as_deref() == Some("DeviceCMYK") {
                return None;
            }
            image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg).ok()
        }
        [f] if f == "FlateDecode" && bpc == 8 => {
            if d.get(b"DecodeParms").is_ok() {
                // Predictors are handled by lopdf's decompression only for some cases; skip them.
                let parms = d.get(b"DecodeParms").ok()?.as_dict().ok()?;
                if parms.get(b"Predictor").map(|p| p.as_i64().unwrap_or(1) > 1).unwrap_or(false) {
                    return None;
                }
            }
            let raw = stream.decompressed_content().ok()?;
            match cs.as_deref() {
                Some("DeviceRGB") if raw.len() >= (width * height * 3) as usize => {
                    image::RgbImage::from_raw(width, height, raw[..(width * height * 3) as usize].to_vec()).map(DynamicImage::ImageRgb8)
                }
                Some("DeviceGray") if raw.len() >= (width * height) as usize => {
                    image::GrayImage::from_raw(width, height, raw[..(width * height) as usize].to_vec()).map(DynamicImage::ImageLuma8)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

pub fn compress(input: &Path, output: &Path, level: Level, strip_metadata: bool, cancel: &Cancel, progress: &dyn Fn(f64)) -> Result<()> {
    let mut doc = Document::load(input).context("Morf can't read this PDF. It may be damaged or password-protected.")?;
    if doc.is_encrypted() {
        anyhow::bail!("This PDF is password-protected. Unlock it first.");
    }
    let p = plan(level);

    let image_ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if name(s.dict.get(b"Subtype").ok()).as_deref() == Some("Image") => Some(*id),
            _ => None,
        })
        .collect();

    let total = image_ids.len().max(1) as f64;
    for (i, id) in image_ids.iter().enumerate() {
        cancel.check()?;
        progress(i as f64 / total * 0.9);
        let Some(Object::Stream(stream)) = doc.objects.get(id) else { continue };
        let Some(picture) = decode(stream) else { continue };
        let (w, h) = picture.dimensions();
        // Tiny pictures (icons, rules) aren't worth touching.
        if w * h < 128 * 128 {
            continue;
        }
        let picture = img::fit(picture, Some(p.max_side));
        let Ok(jpeg) = img::encode_jpeg(&picture, p.quality) else { continue };
        if jpeg.len() >= stream.content.len() {
            continue;
        }
        let (nw, nh) = picture.dimensions();
        let gray = picture.color().channel_count() <= 2;
        if let Some(Object::Stream(s)) = doc.objects.get_mut(id) {
            s.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            s.dict.remove(b"DecodeParms");
            s.dict.set("Width", Object::Integer(nw as i64));
            s.dict.set("Height", Object::Integer(nh as i64));
            s.dict.set("BitsPerComponent", Object::Integer(8));
            s.dict.set("ColorSpace", Object::Name(if gray { b"DeviceGray".to_vec() } else { b"DeviceRGB".to_vec() }));
            s.dict.remove(b"Decode");
            s.set_content(jpeg);
            // set_content keeps the filter we just set; make sure lopdf doesn't recompress it.
            s.allows_compression = false;
        }
    }

    cancel.check()?;
    if strip_metadata {
        if let Ok(info) = doc.trailer.get(b"Info").and_then(|o| o.as_reference()) {
            doc.objects.remove(&info);
            doc.trailer.remove(b"Info");
        }
    }
    doc.prune_objects();
    doc.delete_zero_length_streams();
    doc.compress();
    progress(0.95);
    let mut file = std::fs::File::create(output)?;
    doc.save_to(&mut file)?;
    Ok(())
}
