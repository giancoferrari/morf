/**
 * In-app updates. Morf asks GitHub for `latest.json` (published with each release), downloads the
 * signed installer when there's a newer version, checks its signature against the public key
 * built into the app, installs it and restarts. Nothing is sent but the request for that file.
 */
import { useSyncExternalStore } from "react"
import type { Update } from "@tauri-apps/plugin-updater"
import { inTauri } from "./engine"
import { getPrefs, saveJSON, loadJSON } from "./prefs"

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "available"; version: string; notes: string; date?: string }
  | { kind: "downloading"; version: string; received: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string }

let state: UpdateState = { kind: "idle" }
let pending: Update | null = null
const listeners = new Set<() => void>()
const set = (s: UpdateState) => {
  state = s
  listeners.forEach((l) => l())
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export async function appVersion(): Promise<string> {
  if (!inTauri) return "0.2.0"
  const { getVersion } = await import("@tauri-apps/api/app")
  return getVersion()
}

/** Asks for a newer version. Quiet: never throws, reports through the state. */
export async function checkForUpdate(): Promise<void> {
  if (!inTauri) {
    set({ kind: "current", checkedAt: Date.now() })
    return
  }
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "installing") return
  set({ kind: "checking" })
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const u = await check({ timeout: 20_000 })
    saveJSON("update.checkedAt", Date.now())
    if (u) {
      pending = u
      set({ kind: "available", version: u.version, notes: (u.body ?? "").trim(), date: u.date })
    } else {
      set({ kind: "current", checkedAt: Date.now() })
    }
  } catch (e) {
    const text = String(e)
    // No release published yet, or offline: say it plainly.
    set({
      kind: "error",
      message: /network|dns|connect|timed out|error sending request/i.test(text)
        ? "Couldn't reach the update server. Check your connection."
        : /404|not found|valid release json/i.test(text)
          ? "No update information published yet."
          : text.replace(/^Error:\s*/, ""),
    })
  }
}

/** Downloads, verifies and installs the pending update, then restarts Morf. */
export async function installUpdate(): Promise<void> {
  if (!pending) return
  const u = pending
  let received = 0
  let total: number | null = null
  try {
    set({ kind: "downloading", version: u.version, received: 0, total: null })
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? null
      else if (ev.event === "Progress") {
        received += ev.data.chunkLength
        set({ kind: "downloading", version: u.version, received, total })
      } else if (ev.event === "Finished") set({ kind: "installing", version: u.version })
    })
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (e) {
    set({ kind: "error", message: `The update didn't install: ${String(e).replace(/^Error:\s*/, "")}` })
  }
}

export function lastChecked(): number | null {
  return loadJSON<number | null>("update.checkedAt", null)
}

/** On launch: check after a short pause, at most once every six hours. */
export function scheduleUpdateCheck() {
  if (!inTauri || !getPrefs().autoUpdate) return
  const last = lastChecked() ?? 0
  if (Date.now() - last < 6 * 3600_000) return
  setTimeout(() => void checkForUpdate(), 4000)
}
