#!/usr/bin/env node
// Downloads the ffmpeg build Morf bundles and puts ffmpeg where Tauri's `externalBin`
// expects them: src-tauri/binaries/<name>-<target triple>[.exe].
//
//   node scripts/fetch-ffmpeg.mjs           (skips if already there)
//   node scripts/fetch-ffmpeg.mjs --force
//
// Windows: BtbN's static GPL build of the ffmpeg 8.1 release (x264, x265, SVT-AV1, libaom,
// libvpx, opus, vorbis, lame, libwebp). macOS: a pinned static build (see fetchMac below);
// Homebrew's ffmpeg links to Homebrew libraries and can't be bundled.

import { execFileSync } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "src-tauri", "binaries")
const force = process.argv.includes("--force")

const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim()
const exe = triple.includes("windows") ? ".exe" : ""
const targetTriple = process.env.MORF_FFMPEG_TARGET || triple
const targets = ["ffmpeg"].map((n) => join(outDir, `${n}-${targetTriple}${exe}`))

if (!force && targets.every((t) => existsSync(t))) {
  console.log("ffmpeg already in place:", targets.join(", "))
  process.exit(0)
}

if (triple.endsWith("apple-darwin")) {
  await fetchMac()
  process.exit(0)
}
if (!triple.includes("windows")) {
  console.error(`No bundled ffmpeg for ${triple}. Put a static build at:\n  ${targets.join("\n  ")}`)
  process.exit(1)
}

/**
 * macOS: Martin Riedl's static GPL builds of the ffmpeg 9.1 release (x264, x265, SVT-AV1, libaom,
 * libvpx, opus, vorbis, lame, libwebp; VideoToolbox is part of macOS). Pinned by URL and SHA-256.
 */
async function fetchMac() {
  const builds = {
    "aarch64-apple-darwin": ["arm64/1795207104_9.1", "1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1"],
    "x86_64-apple-darwin": ["amd64/1795212433_9.1", "35b3d82cccc2c1d644d49d15f5e57eb913a08ef68f798042c90eecec62c51f1e"],
  }
  // A cross build (e.g. --target x86_64-apple-darwin on Apple Silicon) can ask for the other one.
  const want = process.env.MORF_FFMPEG_TARGET || triple
  const [path, sha] = builds[want] ?? []
  if (!path) throw new Error(`No pinned macOS ffmpeg for ${want}`)
  const url = `https://ffmpeg.martin-riedl.de/download/macos/${path}/ffmpeg.zip`
  console.log("Downloading", url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { createHash } = await import("node:crypto")
  const got = createHash("sha256").update(buf).digest("hex")
  if (got !== sha) throw new Error(`Checksum mismatch for ${url}: ${got}`)
  const work = mkdtempSync(join(tmpdir(), "morf-ffmpeg-"))
  const zip = join(work, "ffmpeg.zip")
  const { writeFileSync, chmodSync } = await import("node:fs")
  writeFileSync(zip, buf)
  execFileSync("unzip", ["-q", "-o", zip, "-d", work], { stdio: "inherit" })
  mkdirSync(outDir, { recursive: true })
  const dst = join(outDir, `ffmpeg-${want}`)
  copyFileSync(join(work, "ffmpeg"), dst)
  chmodSync(dst, 0o755)
  writeFileSync(
    join(outDir, "FFMPEG-LICENSE.txt"),
    [
      "Morf bundles ffmpeg 9.1, a static build by Martin Riedl (https://ffmpeg.martin-riedl.de),",
      "configured with --enable-gpl --enable-version3. ffmpeg is licensed under the GNU General",
      "Public License version 3 (https://www.gnu.org/licenses/gpl-3.0.html). Its source code is at",
      "https://ffmpeg.org/download.html; the build scripts at https://git.martin-riedl.de/ffmpeg/build-script.",
      "",
    ].join("\n"),
  )
  rmSync(work, { recursive: true, force: true })
  console.log(`  ${dst} (${(statSync(dst).size / 1e6).toFixed(0)} MB)`)
}

const URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
const work = mkdtempSync(join(tmpdir(), "morf-ffmpeg-"))
const zip = join(work, "ffmpeg.zip")

console.log("Downloading", URL)
const res = await fetch(URL)
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
const total = Number(res.headers.get("content-length") ?? 0)
let got = 0
let lastPct = -1
const body = Readable.fromWeb(res.body)
body.on("data", (c) => {
  got += c.length
  const pct = total ? Math.floor((got / total) * 100) : 0
  if (pct !== lastPct && pct % 10 === 0) {
    lastPct = pct
    console.log(`  ${pct}%`)
  }
})
await pipeline(body, createWriteStream(zip))

console.log("Extracting")
// bsdtar ships with Windows 10 and later and reads zip files.
execFileSync("tar", ["-xf", zip, "-C", work], { stdio: "inherit" })
const folder = readdirSync(work).find((d) => d.startsWith("ffmpeg-") && statSync(join(work, d)).isDirectory())
if (!folder) throw new Error("Unexpected archive layout")

mkdirSync(outDir, { recursive: true })
// Only ffmpeg: Morf reads media details from `ffmpeg -i`, so ffprobe (another 168 MB) stays out.
for (const name of ["ffmpeg"]) {
  const src = join(work, folder, "bin", `${name}.exe`)
  const dst = join(outDir, `${name}-${triple}.exe`)
  copyFileSync(src, dst)
  console.log(`  ${dst} (${(statSync(dst).size / 1e6).toFixed(0)} MB)`)
}
copyFileSync(join(work, folder, "LICENSE.txt"), join(outDir, "FFMPEG-LICENSE.txt"))
rmSync(work, { recursive: true, force: true })
console.log("Done.")
