// Points the download buttons at the newest release's files. The links already go to the
// releases page, so the site works without this; GitHub's public API fills in the exact files.
;(async () => {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const primary = document.querySelector('[data-dl="primary"]')
  const secondary = document.querySelector('[data-dl="secondary"]')
  if (mac) {
    primary.textContent = "Download for Mac"
    secondary.textContent = "Download for Windows"
  }

  let release
  try {
    const res = await fetch("https://api.github.com/repos/giancoferrari/morf/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    if (!res.ok) return
    release = await res.json()
  } catch {
    return
  }
  const assets = release.assets || []
  const find = (re) => assets.find((a) => re.test(a.name))
  const files = {
    windows: find(/_x64-setup\.exe$/),
    "mac-arm": find(/_aarch64\.dmg$/),
    "mac-intel": find(/_x64\.dmg$/),
  }
  for (const [key, asset] of Object.entries(files)) {
    if (!asset) continue
    document.querySelectorAll(`[data-dl="${key}"]`).forEach((a) => (a.href = asset.browser_download_url))
  }
  const win = files.windows?.browser_download_url
  const arm = files["mac-arm"]?.browser_download_url
  if (win && arm) {
    primary.href = mac ? arm : win
    secondary.href = mac ? win : arm
  } else if (win && !mac) {
    primary.href = win
  }
  const version = (release.tag_name || "").replace(/^v/, "")
  if (version) document.querySelectorAll("[data-version]").forEach((n) => (n.textContent = version))
  if (files.windows) {
    const size = document.querySelector('[data-size="windows"]')
    if (size) size.textContent = `Installer · ${Math.round(files.windows.size / 1e6)} MB · version ${version}`
  }
})()
