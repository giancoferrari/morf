/**
 * "Saved" announcements. Every tool that writes a file calls `announceSaved`; the window shows a
 * card with the path(s), and when Morf is in the background the system shows a notification too.
 */
import { useSyncExternalStore } from "react"
import { inTauri, reveal } from "./engine"
import { getPrefs } from "./prefs"
import { basename } from "./utils"

export interface SavedFile {
  path: string
  size?: number
}

export interface SavedNotice {
  id: number
  tool: string
  files: SavedFile[]
  /** A short extra line, e.g. "−72% overall" or "2 files couldn't be converted". */
  detail?: string
}

let current: SavedNotice | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function announceSaved(tool: string, files: SavedFile[], detail?: string) {
  if (!files.length) return
  current = { id: ++seq, tool, files, detail }
  emit()
  const prefs = getPrefs()
  if (prefs.revealWhenDone) void reveal(files[0].path)
  if (prefs.notifyWhenDone && !document.hasFocus()) void systemNotify(tool, files)
}

export function dismissSaved() {
  current = null
  emit()
}

export function useSavedNotice(): SavedNotice | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

async function systemNotify(tool: string, files: SavedFile[]) {
  const title = files.length === 1 ? `${tool}: saved ${basename(files[0].path)}` : `${tool}: ${files.length} files saved`
  const body = files.length === 1 ? files[0].path : files.map((f) => basename(f.path)).slice(0, 4).join(", ")
  try {
    if (inTauri) {
      const n = await import("@tauri-apps/plugin-notification")
      let ok = await n.isPermissionGranted()
      if (!ok) ok = (await n.requestPermission()) === "granted"
      if (ok) n.sendNotification({ title, body })
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body })
    }
  } catch {
    /* notifications are a nicety */
  }
}
