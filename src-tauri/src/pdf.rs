//! PDF compression. Almost all of a large PDF's weight is pictures (scans, photos), so each image
//! is decoded, scaled down to a sensible resolution and stored again as JPEG. Text, vectors and
//! fonts are untouched; streams are recompressed and unused objects dropped.
//!
//! Colour is never converted: an image keeps its colour space (RGB, grey, CMYK, an ICC profile),
//! and print JPEGs stored as Adobe CMYK or YCCK are re-encoded in that same form, so a print-ready
//! PDF stays print-ready. Transparency masks are separate objects and stay as they are.

use std::path::Path;

use anyhow::{Context, Result};
use image::{imageops::FilterType, ImageBuffer, Luma, Rgb, Rgba};
use lopdf::{Document, Object, ObjectId};
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;

use crate::jobs::Level;
use crate::tools::Cancel;

struct Plan {
    quality: u8,
    /// Longest side an embedded picture may keep, in pixels.
    max_side: u32,
}

fn plan(level: Level) -> Plan {
    match level {
        // Light keeps print resolution for A4 at ~200 dpi; Balanced is comfortable on any screen;
        // Strong is for email and chat.
        Level::Light => Plan { quality: 76, max_side: 2400 },
        Level::Balanced => Plan { quality: 60, max_side: 1600 },
        Level::Strong => Plan { quality: 45, max_side: 1100 },
    }
}

/// How the pixels are laid out, which decides how they are encoded again.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Layout {
    Gray,
    Rgb,
    /// True CMYK ink values (0 = no ink).
    Cmyk,
    /// Adobe YCCK, kept exactly as stored.
    Ycck,
}

struct Pixels {
    width: u32,
    height: u32,
    layout: Layout,
    data: Vec<u8>,
}

impl Pixels {
    fn channels(&self) -> usize {
        match self.layout {
            Layout::Gray => 1,
            Layout::Rgb => 3,
            Layout::Cmyk | Layout::Ycck => 4,
        }
    }

    /// Lanczos down-scaling, channel by channel. Four-channel data rides in an RGBA buffer, which
    /// `image` resizes without treating the fourth channel as transparency.
    fn shrink(self, max_side: u32) -> Self {
        let (w, h) = (self.width, self.height);
        if w.max(h) <= max_side {
            return self;
        }
        let s = max_side as f64 / w.max(h) as f64;
        let (nw, nh) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
        let data = match self.channels() {
            1 => image::imageops::resize(&ImageBuffer::<Luma<u8>, _>::from_raw(w, h, self.data).unwrap(), nw, nh, FilterType::Lanczos3).into_raw(),
            3 => image::imageops::resize(&ImageBuffer::<Rgb<u8>, _>::from_raw(w, h, self.data).unwrap(), nw, nh, FilterType::Lanczos3).into_raw(),
            _ => image::imageops::resize(&ImageBuffer::<Rgba<u8>, _>::from_raw(w, h, self.data).unwrap(), nw, nh, FilterType::Lanczos3).into_raw(),
        };
        Pixels { width: nw, height: nh, layout: self.layout, data }
    }

    fn encode(&self, quality: u8) -> Option<Vec<u8>> {
        if self.width > 65_535 || self.height > 65_535 {
            return None;
        }
        let mut out = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut out, quality);
        enc.set_progressive(true);
        enc.set_optimized_huffman_tables(true);
        enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
        let (w, h) = (self.width as u16, self.height as u16);
        let r = match self.layout {
            Layout::Gray => enc.encode(&self.data, w, h, jpeg_encoder::ColorType::Luma),
            Layout::Rgb => enc.encode(&self.data, w, h, jpeg_encoder::ColorType::Rgb),
            // Written as Adobe YCCK, the form print JPEGs use and every PDF reader draws the same.
            // (Plain Adobe CMYK is read inverted by some readers and not by others.)
            // jpeg-encoder takes Adobe's inverted CMYK here (checked by rendering with MuPDF).
            Layout::Cmyk => {
                let inverted: Vec<u8> = self.data.iter().map(|v| 255 - v).collect();
                enc.encode(&inverted, w, h, jpeg_encoder::ColorType::CmykAsYcck)
            }
            Layout::Ycck => enc.encode(&self.data, w, h, jpeg_encoder::ColorType::Ycck),
        };
        r.ok().map(|_| out)
    }
}

fn name_of(o: &Object) -> Option<&[u8]> {
    o.as_name().ok()
}

/// Number of colour components a colour space has, when it's one Morf can re-encode.
/// Indexed, Separation, DeviceN, Lab and patterns are left alone.
fn components(doc: &Document, cs: &Object, depth: u8) -> Option<u8> {
    if depth > 4 {
        return None;
    }
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" | b"G" => Some(1),
            b"DeviceRGB" | b"CalRGB" | b"RGB" => Some(3),
            b"DeviceCMYK" | b"CMYK" => Some(4),
            _ => None,
        },
        Object::Reference(id) => components(doc, doc.get_object(*id).ok()?, depth + 1),
        Object::Array(a) => {
            let kind = a.first().and_then(name_of)?;
            match kind {
                b"ICCBased" => {
                    let stream = match a.get(1)? {
                        Object::Reference(id) => doc.get_object(*id).ok()?.as_stream().ok()?,
                        _ => return None,
                    };
                    match stream.dict.get(b"N").ok()?.as_i64().ok()? {
                        n @ (1 | 3 | 4) => Some(n as u8),
                        _ => None,
                    }
                }
                b"CalRGB" => Some(3),
                b"CalGray" => Some(1),
                _ => None,
            }
        }
        _ => None,
    }
}

fn filters(stream: &lopdf::Stream) -> Vec<Vec<u8>> {
    match stream.dict.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec)).collect(),
        _ => vec![],
    }
}

/// The Adobe APP14 marker's transform byte, if the JPEG has one (0 = CMYK/RGB, 1 = YCbCr, 2 = YCCK).
fn adobe_transform(jpeg: &[u8]) -> Option<u8> {
    let mut i = 2;
    while i + 4 < jpeg.len() && jpeg[i] == 0xFF {
        let marker = jpeg[i + 1];
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if marker == 0xEE && len >= 12 && jpeg.get(i + 4..i + 9) == Some(b"Adobe") {
            return jpeg.get(i + 4 + 11).copied();
        }
        if marker == 0xDA {
            break;
        }
        i += 2 + len;
    }
    None
}

/// Decodes an image XObject Morf knows how to rebuild faithfully, or None to leave it alone.
fn decode(doc: &Document, stream: &lopdf::Stream) -> Option<Pixels> {
    let d = &stream.dict;
    if d.get(b"ImageMask").ok().and_then(|m| m.as_bool().ok()).unwrap_or(false) {
        return None;
    }
    // A /Decode array or a colour-key /Mask (an array) ties meaning to exact sample values.
    if d.get(b"Decode").is_ok() || matches!(d.get(b"Mask"), Ok(Object::Array(_))) {
        return None;
    }
    let width = d.get(b"Width").ok()?.as_i64().ok()? as u32;
    let height = d.get(b"Height").ok()?.as_i64().ok()? as u32;
    if d.get(b"BitsPerComponent").ok().and_then(|b| b.as_i64().ok()).unwrap_or(8) != 8 {
        return None;
    }
    let comps = components(doc, d.get(b"ColorSpace").ok()?, 0)?;
    let filters = filters(stream);
    let filters: Vec<&[u8]> = filters.iter().map(Vec::as_slice).collect();

    match filters.as_slice() {
        [b"DCTDecode"] => {
            let jpeg = &stream.content;
            let (layout, out_cs) = match comps {
                1 => (Layout::Gray, ColorSpace::Luma),
                3 => (Layout::Rgb, ColorSpace::RGB),
                _ => match adobe_transform(jpeg) {
                    Some(2) => (Layout::Ycck, ColorSpace::YCCK),
                    // Inside a PDF, readers take a plain CMYK JPEG's samples as ink amounts.
                    Some(0) => (Layout::Cmyk, ColorSpace::CMYK),
                    // CMYK without Adobe's marker means something different to some readers.
                    _ => return None,
                },
            };
            let opts = DecoderOptions::default().jpeg_set_out_colorspace(out_cs).set_max_width(1 << 16).set_max_height(1 << 16);
            let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(&jpeg[..]), opts);
            let data = dec.decode().ok()?;
            let (w, h) = dec.dimensions()?;
            if dec.output_colorspace()? != out_cs || (w as u32, h as u32) != (width, height) {
                return None;
            }
            Some(Pixels { width, height, layout, data })
        }
        [b"FlateDecode"] => {
            if let Ok(parms) = d.get(b"DecodeParms").and_then(|p| p.as_dict()) {
                if parms.get(b"Predictor").ok().and_then(|p| p.as_i64().ok()).unwrap_or(1) > 1 {
                    // lopdf undoes PNG predictors on decompression; TIFF predictors it doesn't.
                    if parms.get(b"Predictor").ok().and_then(|p| p.as_i64().ok()) == Some(2) {
                        return None;
                    }
                }
            }
            let raw = stream.decompressed_content().ok()?;
            let need = width as usize * height as usize * comps as usize;
            if raw.len() < need {
                return None;
            }
            let layout = match comps {
                1 => Layout::Gray,
                3 => Layout::Rgb,
                _ => Layout::Cmyk,
            };
            Some(Pixels { width, height, layout, data: raw[..need].to_vec() })
        }
        _ => None,
    }
}

#[allow(dead_code)]
pub struct PdfReport {
    pub images_seen: usize,
    pub images_rewritten: usize,
}

pub fn compress(input: &Path, output: &Path, level: Level, strip_metadata: bool, cancel: &Cancel, progress: &dyn Fn(f64)) -> Result<PdfReport> {
    let mut doc = Document::load(input).context("Morf can't read this PDF. It may be damaged or password-protected.")?;
    if doc.is_encrypted() {
        anyhow::bail!("This PDF is password-protected. Unlock it first.");
    }
    let p = plan(level);

    let image_ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if s.dict.get(b"Subtype").ok().and_then(name_of) == Some(b"Image") => Some(*id),
            _ => None,
        })
        .collect();

    // Masks are images too, but their pixels must stay sharp and exact: skip anything used as one.
    let mut masks = std::collections::HashSet::new();
    for id in &image_ids {
        if let Some(Object::Stream(s)) = doc.objects.get(id) {
            for key in [b"SMask".as_slice(), b"Mask".as_slice()] {
                if let Ok(Object::Reference(r)) = s.dict.get(key) {
                    masks.insert(*r);
                }
            }
        }
    }

    let mut report = PdfReport { images_seen: image_ids.len(), images_rewritten: 0 };
    let total = image_ids.len().max(1) as f64;
    for (i, id) in image_ids.iter().enumerate() {
        cancel.check()?;
        progress(i as f64 / total * 0.9);
        if masks.contains(id) {
            continue;
        }
        let Some(Object::Stream(stream)) = doc.objects.get(id) else { continue };
        // Tiny pictures (icons, rules) aren't worth touching.
        let area = stream.dict.get(b"Width").ok().and_then(|w| w.as_i64().ok()).unwrap_or(0) * stream.dict.get(b"Height").ok().and_then(|h| h.as_i64().ok()).unwrap_or(0);
        if area < 96 * 96 {
            continue;
        }
        let Some(pixels) = decode(&doc, stream) else { continue };
        let pixels = pixels.shrink(p.max_side);
        let Some(jpeg) = pixels.encode(p.quality) else { continue };
        if jpeg.len() as f64 >= stream.content.len() as f64 * 0.95 {
            continue;
        }
        if let Some(Object::Stream(s)) = doc.objects.get_mut(id) {
            s.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            s.dict.remove(b"DecodeParms");
            s.dict.set("Width", Object::Integer(pixels.width as i64));
            s.dict.set("Height", Object::Integer(pixels.height as i64));
            s.dict.set("BitsPerComponent", Object::Integer(8));
            // ColorSpace stays as it was: same components, same profile.
            s.set_content(jpeg);
            s.allows_compression = false;
            report.images_rewritten += 1;
        }
    }

    cancel.check()?;
    if strip_metadata {
        if let Ok(info) = doc.trailer.get(b"Info").and_then(|o| o.as_reference()) {
            doc.objects.remove(&info);
            doc.trailer.remove(b"Info");
        }
        // XMP packets on every page and image add up in exported design files.
        for o in doc.objects.values_mut() {
            if let Object::Dictionary(dict) = o {
                dict.remove(b"Metadata");
            } else if let Object::Stream(s) = o {
                if s.dict.get(b"Subtype").ok().and_then(name_of) != Some(b"XML") {
                    s.dict.remove(b"Metadata");
                }
            }
        }
        if let Ok(cat) = doc.catalog_mut() {
            cat.remove(b"Metadata");
        }
    }
    doc.prune_objects();
    doc.delete_zero_length_streams();
    doc.compress();
    // Vector art and page content are usually deflated at a fast setting; squeeze them again.
    if level != Level::Light {
        let ids: Vec<ObjectId> = doc.objects.iter().filter(|(_, o)| matches!(o, Object::Stream(_))).map(|(id, _)| *id).collect();
        for id in ids {
            cancel.check()?;
            if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
                let flate_only = filters(s) == [b"FlateDecode".to_vec()] && s.dict.get(b"DecodeParms").is_err();
                if !flate_only || s.content.len() < 1024 {
                    continue;
                }
                let Ok(raw) = s.decompressed_content() else { continue };
                let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                if std::io::Write::write_all(&mut enc, &raw).is_err() {
                    continue;
                }
                if let Ok(again) = enc.finish() {
                    if again.len() < s.content.len() {
                        s.set_content(again);
                        s.allows_compression = false;
                    }
                }
            }
        }
    }
    progress(0.95);
    let mut file = std::fs::File::create(output)?;
    // Object streams pack the thousands of small objects (tags, annotations, forms) in design
    // exports; they often weigh as much as the text.
    doc.save_modern(&mut file)?;
    Ok(report)
}
