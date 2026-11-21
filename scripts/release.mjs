// Builds the signed installer and the `latest.json` that installed copies of Morf read to update
// themselves.
//
//   npm run release                 → build, sign, write latest.json
//   npm run release -- --notes "…"  → the same, with release notes shown in the app
//
// The updater's private key lives outside the repo: %USERPROFILE%\.tauri\morf.key (or set
// TAURI_SIGNING_PRIVATE_KEY yourself). Upload the installer, its .sig and latest.json to the
// GitHub release tagged v<version>; the app looks at releases/latest/download/latest.json.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"))
const version = conf.version
const repo = "giancoferrari/morf"

const notesArg = process.argv.indexOf("--notes")
const notes = notesArg > -1 ? process.argv[notesArg + 1] ?? "" : ""

const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(homedir(), ".tauri", "morf.key")
  if (!existsSync(keyPath)) {
    console.error(`No updater key. Expected ${keyPath}, or set TAURI_SIGNING_PRIVATE_KEY.`)
    process.exit(1)
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim()
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ""

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run("node", ["scripts/fetch-ffmpeg.mjs"])
run("scripts\\vsbuild.cmd", ["npx", "tauri", "build"])

const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis")
const exe = `Morf_${version}_x64-setup.exe`
const sigPath = join(bundle, `${exe}.sig`)
if (!existsSync(sigPath)) {
  console.error(`The build didn't sign ${exe}: ${sigPath} is missing.`)
  process.exit(1)
}

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${exe}`,
    },
  },
}
writeFileSync(join(bundle, "latest.json"), JSON.stringify(latest, null, 2) + "\n")
console.log(`\nReady to upload to the v${version} release:\n  ${join(bundle, exe)}\n  ${sigPath}\n  ${join(bundle, "latest.json")}`)
