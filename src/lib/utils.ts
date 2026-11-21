import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 1536 → "1.5 KB". Decimal units, like Finder and Explorer's size column in recent builds. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)))
  const v = bytes / 1000 ** i
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–"
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return s ? `${m} min ${s} sec` : `${m} min`
  const h = Math.floor(m / 60)
  return `${h} hr ${m % 60} min`
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function extname(path: string): string {
  const b = basename(path)
  const i = b.lastIndexOf(".")
  return i > 0 ? b.slice(i + 1).toLowerCase() : ""
}

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
export const modKey = isMac ? "⌘" : "Ctrl"
