//! PDF passwords for the PDF tool: Protect (AES-256, the PDF 2.0 standard every current reader
//! opens) and Unlock. Page work (merge, split, organise, sign) happens in the window with pdf-lib;
//! encryption lives here because lopdf already does it well.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, Permissions};
use serde::Deserialize;

use crate::paths;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protect {
    pub path: String,
    /// Needed to open the file.
    pub password: String,
    pub allow_print: bool,
    pub allow_copy: bool,
    pub allow_edit: bool,
}

fn is_password_error(e: &lopdf::Error) -> bool {
    let s = format!("{e:?}").to_lowercase();
    s.contains("password") || s.contains("decrypt")
}

/// Writes `doc` beside `input` as `stem suffix.pdf` through a part file. Returns the path.
fn save_beside(doc: &mut Document, input: &Path, suffix: &str) -> Result<String> {
    let (dir, _) = paths::output_dir(input, None);
    let dest = paths::unique_path(&dir, &format!("{}{suffix}", paths::stem_of(input)), "pdf");
    let part = paths::part_path(&dest);
    let written = (|| -> Result<std::path::PathBuf> {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&part)?);
        doc.save_to(&mut f)?;
        drop(f);
        Ok(paths::commit(&part, &dest)?)
    })();
    match written {
        Ok(p) => Ok(p.to_string_lossy().into_owned()),
        Err(e) => {
            paths::discard(&part);
            Err(e)
        }
    }
}

pub fn protect(req: Protect) -> Result<String> {
    if req.password.is_empty() {
        bail!("Choose a password first.");
    }
    let input = Path::new(&req.path);
    let mut doc = Document::load(input).map_err(|e| {
        if is_password_error(&e) {
            anyhow!("This PDF already has a password. Unlock it first, then protect it again.")
        } else {
            anyhow!("Morf can't read this PDF: {e}")
        }
    })?;
    if doc.is_encrypted() {
        bail!("This PDF already has a password. Unlock it first, then protect it again.");
    }

    let mut perms = Permissions::COPYABLE_FOR_ACCESSIBILITY | Permissions::FILLABLE;
    if req.allow_print {
        perms |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if req.allow_copy {
        perms |= Permissions::COPYABLE;
    }
    if req.allow_edit {
        perms |= Permissions::MODIFIABLE | Permissions::ANNOTABLE | Permissions::ASSEMBLABLE;
    }

    // The owner password lifts the restrictions above. Nobody needs to know it, so it's random:
    // the person's password opens the file, and the limits stay limits.
    let mut owner = [0u8; 24];
    getrandom::fill(&mut owner).map_err(|e| anyhow!("{e}"))?;
    let owner: String = owner.iter().map(|b| format!("{b:02x}")).collect();
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| anyhow!("{e}"))?;

    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password: &req.password,
        permissions: perms,
    };
    let state = EncryptionState::try_from(version).map_err(|e| anyhow!("{e}"))?;
    doc.encrypt(&state).map_err(|e| anyhow!("Couldn't protect this PDF: {e}"))?;
    save_beside(&mut doc, input, " (protected)")
}

pub fn unlock(path: &str, password: &str) -> Result<String> {
    let input = Path::new(path);
    let mut doc = Document::load_with_password(input, password).map_err(|e| {
        if is_password_error(&e) {
            anyhow!("That password isn't right.")
        } else {
            anyhow!("Morf can't read this PDF: {e}")
        }
    })?;
    if doc.is_encrypted() {
        doc.decrypt(password).map_err(|_| anyhow!("That password isn't right."))?;
    }
    save_beside(&mut doc, input, " (unlocked)")
}

/// Whether a PDF needs a password to open. Restrictions alone (an empty open password) don't count.
pub fn needs_password(path: &str) -> bool {
    match Document::load(path) {
        Ok(doc) => doc.is_encrypted(),
        Err(e) => is_password_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object, Stream};

    fn sample(path: &Path) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let content = doc.add_object(Stream::new(dictionary! {}, b"0 0 m 10 10 l S".to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        doc.save(path).unwrap();
    }

    #[test]
    fn protect_then_unlock() {
        let dir = std::env::temp_dir().join(format!("morf-pdfsec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("doc.pdf");
        sample(&src);
        let locked = protect(Protect { path: src.to_string_lossy().into(), password: "hunter2".into(), allow_print: true, allow_copy: false, allow_edit: false }).unwrap();
        assert!(locked.ends_with("doc (protected).pdf"));
        assert!(needs_password(&locked));
        assert!(unlock(&locked, "wrong").is_err());
        let open = unlock(&locked, "hunter2").unwrap();
        assert!(!needs_password(&open));
        assert_eq!(Document::load(&open).unwrap().get_pages().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
