//! "Convert with Morf" and "Compress with Morf" in the file manager's right-click menu.
//!
//! Windows: per-user verbs under HKCU\Software\Classes\*\shell, no admin rights needed. On
//! Windows 11 they appear under "Show more options"; a top-level entry needs a signed sparse
//! package, which the installer will add later. macOS: a Finder Quick Action (planned).

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const VERBS: &[(&str, &str, &str)] = &[("Morf.Convert", "Convert with Morf", "convert"), ("Morf.Compress", "Compress with Morf", "compress")];

    fn base() -> Result<RegKey> {
        Ok(RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software\\Classes", winreg::enums::KEY_ALL_ACCESS)?)
    }

    pub fn install() -> Result<()> {
        let exe = std::env::current_exe()?;
        let exe = exe.to_string_lossy();
        let classes = base()?;
        for (key, label, tool) in VERBS {
            let (verb, _) = classes.create_subkey(format!("*\\shell\\{key}"))?;
            verb.set_value("MUIVerb", &label.to_string())?;
            verb.set_value("Icon", &format!("\"{exe}\",0"))?;
            verb.set_value("MultiSelectModel", &"Player".to_string())?;
            let (cmd, _) = verb.create_subkey("command")?;
            cmd.set_value("", &format!("\"{exe}\" --tool {tool} \"%1\""))?;
        }
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let classes = base()?;
        for (key, _, _) in VERBS {
            let _ = classes.delete_subkey_all(format!("*\\shell\\{key}"));
        }
        Ok(())
    }

    pub fn installed() -> bool {
        base().and_then(|c| Ok(c.open_subkey(format!("*\\shell\\{}", VERBS[0].0))?)).is_ok()
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::{bail, Result};
    pub fn install() -> Result<()> {
        bail!("The Finder Quick Action is coming in a later version.")
    }
    pub fn uninstall() -> Result<()> {
        Ok(())
    }
    pub fn installed() -> bool {
        false
    }
}

pub use imp::{install, installed, uninstall};
