fn main() {
  // On macOS the speech engine's Metal code uses `@available`, which needs
  // `__isPlatformVersionAtLeast` from clang's runtime library. Rust links without clang's default
  // libraries, so add that one explicitly.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    if let Ok(out) = std::process::Command::new("clang").arg("--print-resource-dir").output() {
      let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
      if !dir.is_empty() {
        println!("cargo:rustc-link-search=native={dir}/lib/darwin");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
      }
    }
  }
  tauri_build::build()
}
