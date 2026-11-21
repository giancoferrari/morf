#!/usr/bin/env node
// Downloads the ffmpeg build Morf bundles and puts ffmpeg where Tauri's `externalBin`
// expects them: src-tauri/binaries/<name>-<target triple>[.exe].
//
//   node scripts/fetch-ffmpeg.mjs           (skips if already there)
//   node scripts/fetch-ffmpeg.mjs --force
//
// Windows: BtbN's static GPL build of the ffmpeg 8.1 release (x264, x265, SVT-AV1, libaom,
// libvpx, opus, vorbis, lame, libwebp). macOS: put static builds in place by hand for now
// (see the message below); Homebrew's ffmpeg links to Homebrew libraries and can't be bundled.

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
const targets = ["ffmpeg"].map((n) => join(outDir, `${n}-${triple}${exe}`))

if (!force && targets.every((t) => existsSync(t))) {
  console.log("ffmpeg already in place:", targets.join(", "))
  process.exit(0)
}

if (!triple.includes("windows")) {
  console.error(
    `Put a static ffmpeg build for ${triple} at:\n  ${targets.join("\n  ")}\n` +
      "For example from https://www.osxexperts.net (Apple Silicon) or https://evermeet.cx/ffmpeg (Intel).",
  )
  process.exit(1)
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
