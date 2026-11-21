#!/usr/bin/env node
// Captures the README screenshots from the interface running in a browser (`npm run dev`, mock
// engine) with headless Chrome over the DevTools protocol. No extra dependencies.
//
//   npm run dev            (in another terminal)
//   node scripts/screenshots.mjs

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "docs", "screenshots")
mkdirSync(out, { recursive: true })

const CHROME =
  process.env.CHROME ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome")
const URL = process.env.MORF_URL ?? "http://localhost:1420/"
const W = 1440
const H = 900
const PORT = 9333

const profile = mkdtempSync(join(tmpdir(), "morf-shots-"))
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    target = list.find((t) => t.type === "page")
  } catch {}
}
if (!target) throw new Error("Chrome didn't start")

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener("open", r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value

await send("Page.enable")
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false })

async function fresh(prefs, extra = {}) {
  await send("Page.navigate", { url: URL })
  await sleep(800)
  await js(`localStorage.clear(); localStorage.setItem('morf.prefs.v1', ${JSON.stringify(JSON.stringify(prefs))}); ${Object.entries(extra)
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`)
    .join("")} location.reload(); true`)
  await sleep(1800)
}
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"))
  console.log("  " + name)
}
const clickText = (t) => js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(t)}))?.click(); true`)
const drop = (files) =>
  js(`(() => {
    const dt = new DataTransfer();
    ${JSON.stringify(files)}.forEach(([n, s, t]) => dt.items.add(new File([new Uint8Array(s)], n, { type: t })));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }));
    return true })()`)

console.log("Capturing")
await fresh({ theme: "light", indexView: "list" })
await shot("index")

await fresh({ theme: "dark", indexView: "list" })
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); true`)
await sleep(700)
await shot("index-dark")

await fresh({ theme: "light", indexView: "grid" })
await shot("grid")

await fresh({ theme: "light", indexView: "list" })
await clickText("Convert")
await sleep(500)
await drop([
  ["Interview with Ana.mov", 48_000_000, "video/quicktime"],
  ["Band rehearsal.mp4", 212_000_000, "video/mp4"],
  ["Lisbon, golden hour.mov", 96_400_000, "video/quicktime"],
  ["Studio session take 4.mov", 31_700_000, "video/quicktime"],
])
await sleep(900)
await clickText("MP4")
await sleep(400)
await shot("convert")

await fresh({ theme: "light", indexView: "list" })
await clickText("Compress")
await sleep(500)
await drop([
  ["Wedding highlights.mp4", 812_000_000, "video/mp4"],
  ["IMG_4412.jpg", 7_400_000, "image/jpeg"],
  ["Quarterly report (scanned).pdf", 38_100_000, "application/pdf"],
  ["Podcast episode 12.wav", 412_000_000, "audio/wav"],
])
await sleep(900)
await clickText("Compress 4 files")
await sleep(16000)
await shot("compress")

await fresh(
  { theme: "light", indexView: "list" },
  {
    "morf.count.draft":
      "Their going to love the new studio. The light comes in from the north, so the afternoons stay soft and even, and the big table fits everyone for Friday reviews.\n\nWe should of moved here sooner. Good light is is the cheapest tool a designer can buy, and good light makes the work feel calmer, the meetings shorter and the coffee better.\n\nNext week we test the new reading corner, the long shelf for printed proofs, and a quiet room for calls.",
    "morf.count.goal": 250,
  },
)
await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true })); true`)
await sleep(7000)
await shot("count")

ws.close()
chrome.kill()
await sleep(500)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {}
console.log("Saved to", out)
