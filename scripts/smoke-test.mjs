#!/usr/bin/env node
// The conversion smoke test. Generates small sample files with ffmpeg (a hi-res WAV, a short video
// with sound, a photo-like PNG with transparency, a JPEG, a PDF with a big picture inside), then
// runs every Convert format each one is offered and every Compress level through `morf --cli`.
// Any failure is listed and fails the run.
//
//   node scripts/smoke-test.mjs            (builds the debug engine first)

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const tauri = join(root, "src-tauri")
const win = process.platform === "win32"
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim()
const ffmpeg = join(tauri, "binaries", `ffmpeg-${triple}${win ? ".exe" : ""}`)

console.log("Building the engine…")
execFileSync("cargo", ["build", "--quiet"], { cwd: tauri, stdio: "inherit" })
const morf = join(tauri, "target", "debug", `morf${win ? ".exe" : ""}`)

const work = mkdtempSync(join(tmpdir(), "morf-smoke-"))
const ff = (...args) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" })

console.log("Making samples in", work)
const wav = join(work, "tone hi-res.wav")
ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=4", "-c:a", "pcm_s24le", wav)
const video = join(work, "clip.mov")
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", video)
const png = join(work, "graphic.png")
ff("-f", "lavfi", "-i", "gradients=size=1600x1000:n=5:seed=7,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-800,Y-500),450),255,90)'", "-frames:v", "1", png)
const jpg = join(work, "photo.jpg")
ff("-f", "lavfi", "-i", "mandelbrot=size=3000x2000", "-frames:v", "1", "-q:v", "1", jpg)

// A one-page PDF wrapping a high-quality JPEG, so PDF compression has something to do.
const pdfPath = join(work, "scan.pdf")
{
  const r = spawnSync(morf, ["--cli", "convert", "pdf-image", jpg], { encoding: "utf8", env: { ...process.env, MORF_SETTINGS: '{"imageQuality":98}' } })
  const out = /-> (.+?) \(/.exec(r.stdout)?.[1]
  if (!out) throw new Error("Couldn't make the sample PDF: " + r.stdout + r.stderr)
  execFileSync(win ? "cmd" : "mv", win ? ["/c", "move", "/y", out, pdfPath] : [out, pdfPath])
}

const formats = spawnSync(morf, ["--cli", "formats"], { encoding: "utf8" })
  .stdout.trim()
  .split("\n")
  .map((l) => l.split(/\s+/)[0])

const audioFmts = ["mp3", "m4a-aac", "m4a-heaac", "wav", "aiff", "flac", "alac", "opus", "ogg", "wma", "ac3", "wavpack", "mp2"].filter((f) => formats.includes(f))
const videoFmts = ["mp4-h264", "mp4-hevc", "mp4-av1", "mov-prores", "webm-vp9", "mkv", "gif"].filter((f) => formats.includes(f))
const imageFmts = ["jpeg", "png", "webp", "avif", "tiff", "gif-image", "bmp", "ico", "pdf-image"].filter((f) => formats.includes(f))

const runs = [
  ...audioFmts.map((f) => ["convert", f, wav]),
  ...audioFmts.slice(0, 3).map((f) => ["convert", f, video]),
  ...videoFmts.map((f) => ["convert", f, video]),
  ...imageFmts.map((f) => ["convert", f, png]),
  ...["jpeg", "webp", "avif"].filter((f) => formats.includes(f)).map((f) => ["convert", f, jpg]),
  ...["light", "balanced", "strong", "1mb"].flatMap((lvl) => [video, wav, png, jpg, pdfPath].map((file) => ["compress", lvl, file])),
]

const failures = []
for (const [op, arg, file] of runs) {
  const r = spawnSync(morf, ["--cli", op, arg, file], { encoding: "utf8", env: { ...process.env, MORF_OUT_DIR: work } })
  const line = (r.stdout || r.stderr).trim()
  const size = statSync(file).size
  const out = /\((\d+) bytes/.exec(line)?.[1]
  const pct = out ? ` ${Math.round((1 - Number(out) / size) * 100)}% smaller` : ""
  console.log(`${op.padEnd(8)} ${arg.padEnd(10)} ${file.split(/[\\/]/).pop().padEnd(16)} ${line.split(" ")[0]}${op === "compress" ? pct : ""}`)
  if (r.status !== 0) failures.push(`${op} ${arg} ${file}: ${line}`)
}

rmSync(work, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} failed:\n` + failures.join("\n"))
  process.exit(1)
}
console.log(`\nAll ${runs.length} conversions passed.`)
