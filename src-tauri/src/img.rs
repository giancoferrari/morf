//! Images: decoding (with camera rotation applied), resizing, and the encoders Morf uses to make
//! files small without visible loss: progressive JPEG with optimised tables, libwebp, palette PNG
//! through libimagequant plus oxipng, and AVIF through ffmpeg.

use std::io::Cursor;
use std::path::Path;

use anyhow::{anyhow, bail, Result};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader};

use crate::jobs::Level;
use crate::tools::Cancel;

/// Formats the `image` crate can't read (HEIC, AVIF, camera RAW) are first turned into a PNG by
/// ffmpeg; this error tells the caller to do that.
#[derive(Debug)]
pub struct NeedsFfmpegDecode;
impl std::fmt::Display for NeedsFfmpegDecode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("needs ffmpeg to decode")
    }
}
impl std::error::Error for NeedsFfmpegDecode {}

pub fn load(path: &Path) -> Result<DynamicImage> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    if reader.format().is_none() {
        return Err(NeedsFfmpegDecode.into());
    }
    let mut decoder = match reader.into_decoder() {
        Ok(d) => d,
        Err(image::ImageError::Unsupported(_)) => return Err(NeedsFfmpegDecode.into()),
        Err(e) => return Err(e.into()),
    };
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Shrinks so the longest side is at most `max`. Never enlarges.
pub fn fit(img: DynamicImage, max: Option<u32>) -> DynamicImage {
    match max {
        Some(m) if img.width().max(img.height()) > m => img.resize(m, m, FilterType::Lanczos3),
        _ => img,
    }
}

pub fn parse_max(s: Option<&str>) -> Option<u32> {
    s.filter(|v| *v != "original" && *v != "source").and_then(|v| v.parse().ok())
}

/// JPEG has no transparency: transparent pixels go onto white rather than black.
fn flatten(img: &DynamicImage) -> image::RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
    }
    out
}

pub fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let (w, h) = img.dimensions();
    if w > 65_535 || h > 65_535 {
        bail!("This image is too large for JPEG (over 65,535 pixels on a side).");
    }
    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
    enc.set_progressive(true);
    enc.set_optimized_huffman_tables(true);
    // Full colour resolution at high quality; 4:2:0 below that, where it is invisible and saves a lot.
    enc.set_sampling_factor(if quality >= 90 { jpeg_encoder::SamplingFactor::R_4_4_4 } else { jpeg_encoder::SamplingFactor::R_4_2_0 });
    if img.color().channel_count() <= 2 && !img.color().has_alpha() {
        let luma = img.to_luma8();
        enc.encode(luma.as_raw(), w as u16, h as u16, jpeg_encoder::ColorType::Luma)?;
    } else {
        let rgb = flatten(img);
        enc.encode(rgb.as_raw(), w as u16, h as u16, jpeg_encoder::ColorType::Rgb)?;
    }
    Ok(out)
}

pub fn encode_webp(img: &DynamicImage, quality: Option<f32>) -> Result<Vec<u8>> {
    let (w, h) = img.dimensions();
    if w > 16_383 || h > 16_383 {
        bail!("This image is too large for WebP (over 16,383 pixels on a side).");
    }
    let mem = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let e = webp::Encoder::from_rgba(rgba.as_raw(), w, h);
        match quality { Some(q) => e.encode(q), None => e.encode_lossless() }
    } else {
        let rgb = img.to_rgb8();
        let e = webp::Encoder::from_rgb(rgb.as_raw(), w, h);
        match quality { Some(q) => e.encode(q), None => e.encode_lossless() }
    };
    Ok(mem.to_vec())
}

fn encode_with(img: &DynamicImage, fmt: ImageFormat) -> Result<Vec<u8>> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, fmt)?;
    Ok(buf.into_inner())
}

/// Lossless PNG, squeezed by oxipng.
pub fn encode_png(img: &DynamicImage, effort: u8) -> Result<Vec<u8>> {
    let raw = encode_with(img, ImageFormat::Png)?;
    let mut opts = oxipng::Options::from_preset(effort);
    opts.strip = oxipng::StripChunks::Safe;
    Ok(oxipng::optimize_from_memory(&raw, &opts).unwrap_or(raw))
}

/// Palette PNG: up to 256 colours chosen by libimagequant (what pngquant uses), then oxipng,
/// which stores it as an indexed PNG. Typically 60–80% smaller than the original PNG.
pub fn encode_png_quantized(img: &DynamicImage, min_q: u8, max_q: u8, effort: u8) -> Result<Vec<u8>> {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let pixels: Vec<imagequant::RGBA> = rgba.pixels().map(|p| imagequant::RGBA::new(p[0], p[1], p[2], p[3])).collect();
    let mut attr = imagequant::new();
    attr.set_quality(min_q, max_q).map_err(|e| anyhow!("{e}"))?;
    attr.set_speed(3).map_err(|e| anyhow!("{e}"))?;
    let mut image = attr.new_image(pixels, w as usize, h as usize, 0.0).map_err(|e| anyhow!("{e}"))?;
    let mut res = match attr.quantize(&mut image) {
        Ok(r) => r,
        // The image needs more colours than the quality floor allows: keep it lossless.
        Err(imagequant::Error::QualityTooLow) => return encode_png(img, effort),
        Err(e) => return Err(anyhow!("{e}")),
    };
    res.set_dithering_level(1.0).map_err(|e| anyhow!("{e}"))?;
    let (palette, indexes) = res.remapped(&mut image).map_err(|e| anyhow!("{e}"))?;
    let mut out = image::RgbaImage::new(w, h);
    for (i, px) in out.pixels_mut().enumerate() {
        let c = palette[indexes[i] as usize];
        *px = image::Rgba([c.r, c.g, c.b, c.a]);
    }
    encode_png(&DynamicImage::ImageRgba8(out), effort)
}

/// A one-page PDF holding the picture as a JPEG, sized at 150 dpi.
pub fn encode_pdf(img: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let jpeg = encode_jpeg(img, quality)?;
    let (w, h) = img.dimensions();
    let gray = img.color().channel_count() <= 2 && !img.color().has_alpha();
    let (pw, ph) = (w as f64 * 72.0 / 150.0, h as f64 * 72.0 / 150.0);
    let content = format!("q {pw:.2} 0 0 {ph:.2} 0 0 cm /Im0 Do Q");
    let mut pdf: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![];
    let mut obj = |pdf: &mut Vec<u8>, body: &[u8]| {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    };
    obj(&mut pdf, b"<< /Type /Catalog /Pages 2 0 R >>");
    obj(&mut pdf, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(&mut pdf, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>").as_bytes());
    let mut img_obj = format!(
        "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /{} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
        if gray { "DeviceGray" } else { "DeviceRGB" },
        jpeg.len()
    )
    .into_bytes();
    img_obj.extend_from_slice(&jpeg);
    img_obj.extend_from_slice(b"\nendstream");
    obj(&mut pdf, &img_obj);
    obj(&mut pdf, format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).as_bytes());
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes());
    for o in &offsets {
        pdf.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1).as_bytes());
    Ok(pdf)
}

/// Encodes for a Convert image target. AVIF returns None: it goes through ffmpeg.
pub fn encode_target(id: &str, img: &DynamicImage, quality: u8) -> Result<Option<Vec<u8>>> {
    Ok(Some(match id {
        "jpeg" => encode_jpeg(img, quality)?,
        "png" => encode_png(img, 2)?,
        "webp" => encode_webp(img, Some(quality as f32))?,
        "tiff" => encode_with(img, ImageFormat::Tiff)?,
        "bmp" => encode_with(&DynamicImage::ImageRgba8(img.to_rgba8()), ImageFormat::Bmp)?,
        "gif-image" => encode_with(&DynamicImage::ImageRgba8(img.to_rgba8()), ImageFormat::Gif)?,
        "ico" => encode_with(&fit(img.clone(), Some(256)), ImageFormat::Ico)?,
        "pdf-image" => encode_pdf(img, quality)?,
        "avif" => return Ok(None),
        other => bail!("Unknown image format {other}"),
    }))
}

/* ------------------------------------------------------------------------------------------------
 * Compression
 * ----------------------------------------------------------------------------------------------*/

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutFmt {
    Jpeg,
    Png,
    Webp,
    Avif,
}

impl OutFmt {
    pub fn ext(self) -> &'static str {
        match self {
            OutFmt::Jpeg => "jpg",
            OutFmt::Png => "png",
            OutFmt::Webp => "webp",
            OutFmt::Avif => "avif",
        }
    }
}

/// What a compressed image is saved as. "Keep" keeps the type when it can be written; HEIC and
/// camera RAW become JPEG, BMP and TIFF become PNG (lossless, far smaller).
pub fn compress_format(choice: &str, input_ext: &str, has_alpha: bool) -> OutFmt {
    match choice {
        "jpeg" => OutFmt::Jpeg,
        "webp" => OutFmt::Webp,
        "avif" => OutFmt::Avif,
        "png" => OutFmt::Png,
        _ => match input_ext {
            "png" | "bmp" | "tif" | "tiff" | "gif" | "ico" => OutFmt::Png,
            "webp" => OutFmt::Webp,
            "avif" => OutFmt::Avif,
            _ if has_alpha => OutFmt::Png,
            _ => OutFmt::Jpeg,
        },
    }
}

pub fn level_quality(fmt: OutFmt, level: Level) -> u8 {
    match (fmt, level) {
        (OutFmt::Jpeg, Level::Light) => 86,
        (OutFmt::Jpeg, Level::Balanced) => 76,
        (OutFmt::Jpeg, Level::Strong) => 62,
        (OutFmt::Webp, Level::Light) => 85,
        (OutFmt::Webp, Level::Balanced) => 74,
        (OutFmt::Webp, Level::Strong) => 58,
        // AVIF "quality" is mapped to a CRF when encoding.
        (OutFmt::Avif, Level::Light) => 80,
        (OutFmt::Avif, Level::Balanced) => 66,
        (OutFmt::Avif, Level::Strong) => 50,
        (OutFmt::Png, _) => 0,
    }
}

/// Encodes one compression attempt in-process. AVIF returns None (ffmpeg does it).
pub fn compress_once(img: &DynamicImage, fmt: OutFmt, level: Level, quality: u8, cancel: &Cancel) -> Result<Option<Vec<u8>>> {
    cancel.check()?;
    Ok(Some(match fmt {
        OutFmt::Jpeg => encode_jpeg(img, quality)?,
        OutFmt::Webp => encode_webp(img, Some(quality as f32))?,
        OutFmt::Png => match level {
            Level::Light => encode_png(img, 4)?,
            Level::Balanced => encode_png_quantized(img, 70, 92, 3)?,
            Level::Strong => encode_png_quantized(img, 35, 75, 3)?,
        },
        OutFmt::Avif => return Ok(None),
    }))
}

/// AVIF quality 0–100 to an AV1 CRF (lower is better).
pub fn avif_crf(quality: u8) -> u32 {
    (63.0 - quality as f64 * 0.5).round().clamp(10.0, 55.0) as u32
}

/// Strong compression also caps very large photos (48 MP phone shots) at 4K on the long side.
pub fn level_max_side(level: Level) -> Option<u32> {
    match level {
        Level::Strong => Some(3840),
        _ => None,
    }
}
