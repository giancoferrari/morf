import { useSyncExternalStore } from "react"

/** App preferences, kept in localStorage and shared by every component that reads them. */
export interface Prefs {
  theme: "light" | "dark" | "system"
  indexView: "list" | "grid"
  /** Where results go: next to each original, or one chosen folder. */
  outputMode: "beside" | "folder"
  outputFolder: string | null
  trashOriginals: boolean
  revealWhenDone: boolean
  notifyWhenDone: boolean
  hardware: boolean
  /** Keep the per-format choices made under Advanced. */
  rememberFormatSettings: boolean
  reduceMotion: boolean
  dialect: "American" | "British" | "Canadian" | "Australian"
}

const DEFAULTS: Prefs = {
  theme: "system",
  indexView: "list",
  outputMode: "beside",
  outputFolder: null,
  trashOriginals: false,
  revealWhenDone: false,
  notifyWhenDone: true,
  hardware: true,
  rememberFormatSettings: true,
  reduceMotion: false,
  dialect: "American",
}

const KEY = "morf.prefs.v1"
let state: Prefs = load()
const listeners = new Set<() => void>()

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  state = { ...state, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* private mode: keep it in memory */
  }
  listeners.forEach((l) => l())
}

export function getPrefs() {
  return state
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

/** A small keyed store for per-tool state that should survive a restart (drafts, last choices). */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`morf.${key}`)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(`morf.${key}`, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}
