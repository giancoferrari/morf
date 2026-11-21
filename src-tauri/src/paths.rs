//! Where results go. Three rules, taken from Convert and kept everywhere:
//!
//! - Nothing is overwritten: `name.ext`, then `name 2.ext`, `name 3.ext`, …
//! - Nothing half-written stays: work goes to a hidden part file that is renamed when complete.
//! - A folder that can't be written to (a disk image, a locked share) sends the result to Downloads.

use std::fs;
use std::path::{Path, PathBuf};

/// The folder a result should land in, and whether that is the Downloads fallback.
pub fn output_dir(input: &Path, chosen: Option<&Path>) -> (PathBuf, bool) {
    let preferred = chosen
        .map(Path::to_path_buf)
        .or_else(|| input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    if is_writable(&preferred) {
        return (preferred, false);
    }
    let fallback = std::env::var_os("MORF_FALLBACK_DIR")
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .unwrap_or_else(std::env::temp_dir);
    (fallback, true)
}

/// Attributes and permissions don't know about write-protected media or what a server allows;
/// creating a file does.
fn is_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".morf-write-test-{}", std::process::id()));
    match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// `dir/stem.ext`, or the first free `dir/stem N.ext`.
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let make = |n: u32| {
        let name = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} {n}.{ext}") };
        dir.join(name)
    };
    let mut n = 1;
    loop {
        let p = make(n);
        if !p.exists() && !part_path(&p).exists() {
            return p;
        }
        n += 1;
    }
}

/// The in-progress name for `final_path`. Same folder (so the final rename is atomic), same
/// extension (so ffmpeg picks the right container), hidden-ish prefix.
pub fn part_path(final_path: &Path) -> PathBuf {
    let name = final_path.file_name().and_then(|n| n.to_str()).unwrap_or("output");
    final_path.with_file_name(format!(".morf-part-{name}"))
}

/// Moves a finished part file into place without replacing anything that appeared meanwhile.
pub fn commit(part: &Path, final_path: &Path) -> std::io::Result<PathBuf> {
    let mut target = final_path.to_path_buf();
    if target.exists() {
        let dir = target.parent().unwrap_or(Path::new("."));
        let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("output").to_string();
        let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
        target = unique_path(dir, &stem, &ext);
    }
    fs::rename(part, &target)?;
    Ok(target)
}

pub fn stem_of(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("output").to_string()
}

pub fn ext_of(path: &Path) -> String {
    path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Removes whatever a stopped or failed job left behind.
pub fn discard(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_taken_names() {
        let dir = std::env::temp_dir().join(format!("morf-paths-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("song.mp3"), b"x").unwrap();
        fs::write(dir.join("song 2.mp3"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "song", "mp3"), dir.join("song 3.mp3"));
        assert_eq!(unique_path(&dir, "other", "mp3"), dir.join("other.mp3"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
