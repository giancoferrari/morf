/**
 * The bridge to Morf's Rust engine. Inside the app every call goes to a Tauri command; in a plain
 * browser (design work with `npm run dev`) a mock answers instead, so every screen can be seen
 * without the engine.
 */
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { extname } from "./utils"

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export type Kind = "audio" | "video" | "image" | "pdf" | "document" | "font" | "unknown"

export type OptionKey =
  | "bitrate"
  | "sampleRate"
  | "channels"
  | "bitDepth"
  | "quality"
  | "resolution"
  | "fps"
  | "keepAudio"
  | "hardware"
  | "gifWidth"
  | "gifFps"
  | "imageQuality"
  | "maxSize"

export interface Target {
  id: string
  label: string
  ext: string
  group: "audio" | "video" | "image"
  /** Kinds of input this target can be made from. */
  accepts: Kind[]
  options: OptionKey[]
  detail?: string
  lossless?: boolean
}

export interface FileInfo {
  path: string
  name: string
  ext: string
  size: number
  kind: Kind
  /** Seconds, for audio and video. */
  duration?: number
  width?: number
  height?: number
  /** A sentence when the file can't be used, e.g. its contents don't match its name. */
  problem?: string
}

export interface EngineStatus {
  ffmpeg: { path: string; version: string; bundled: boolean } | null
  hwEncoders: string[]
  platform: "windows" | "macos" | "linux"
  /** "Convert with Morf" is in the file manager's right-click menu. */
  shellMenu: boolean
}

/** Every setting a conversion or compression can take. Unset means the format's default. */
export interface JobSettings {
  bitrate?: string
  sampleRate?: string
  channels?: string
  bitDepth?: string
  quality?: number
  resolution?: string
  fps?: string
  keepAudio?: boolean
  hardware?: boolean
  gifWidth?: string
  gifFps?: string
  imageQuality?: number
  maxSize?: string
  // compression
  level?: "light" | "balanced" | "strong"
  targetMB?: number | null
  videoCodec?: "h264" | "h265" | "av1"
  imageFormat?: "keep" | "jpeg" | "webp" | "avif" | "png"
  audioFormat?: "keep" | "opus" | "aac" | "mp3"
  maxDimension?: string
  stripMetadata?: boolean
}

export interface JobRequest {
  jobId: string
  op: "convert" | "compress"
  path: string
  target?: string
  settings: JobSettings
  outDir?: string | null
  trashOriginal?: boolean
}

export type JobState = "queued" | "running" | "done" | "failed" | "stopped"

export interface JobEvent {
  jobId: string
  state: JobState
  /** 0…1, or -1 when unknown. */
  progress: number
  output?: string
  outSize?: number
  /** True when the folder was read-only and the result went to Downloads. */
  fallback?: boolean
  error?: string
}

/* -------------------------------------------------------------------------------------------------
 * Catalog. The engine owns the real list; the mock mirrors its shape.
 * -----------------------------------------------------------------------------------------------*/

const AUDIO_OPTS: OptionKey[] = ["bitrate", "sampleRate", "channels"]
const LOSSLESS_OPTS: OptionKey[] = ["sampleRate", "channels", "bitDepth"]
const VIDEO_OPTS: OptionKey[] = ["quality", "resolution", "fps", "keepAudio", "hardware"]
const AV: Kind[] = ["audio", "video"]

const MOCK_TARGETS: Target[] = [
  { id: "mp4-h264", label: "MP4", detail: "H.264", ext: "mp4", group: "video", accepts: ["video"], options: VIDEO_OPTS },
  { id: "mp4-hevc", label: "MP4", detail: "HEVC", ext: "mp4", group: "video", accepts: ["video"], options: VIDEO_OPTS },
  { id: "mp4-av1", label: "MP4", detail: "AV1", ext: "mp4", group: "video", accepts: ["video"], options: VIDEO_OPTS.filter((o) => o !== "hardware") },
  { id: "mov-prores", label: "MOV", detail: "ProRes 422", ext: "mov", group: "video", accepts: ["video"], options: ["resolution", "fps", "keepAudio"] },
  { id: "webm-vp9", label: "WebM", detail: "VP9", ext: "webm", group: "video", accepts: ["video"], options: ["quality", "resolution", "fps", "keepAudio"] },
  { id: "mkv", label: "MKV", detail: "H.264", ext: "mkv", group: "video", accepts: ["video"], options: VIDEO_OPTS },
  { id: "gif", label: "GIF", detail: "Animated", ext: "gif", group: "video", accepts: ["video"], options: ["gifWidth", "gifFps"] },
  { id: "mp3", label: "MP3", ext: "mp3", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "m4a-aac", label: "M4A", detail: "AAC", ext: "m4a", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "wav", label: "WAV", ext: "wav", group: "audio", accepts: AV, options: LOSSLESS_OPTS, lossless: true },
  { id: "aiff", label: "AIFF", ext: "aiff", group: "audio", accepts: AV, options: LOSSLESS_OPTS, lossless: true },
  { id: "flac", label: "FLAC", ext: "flac", group: "audio", accepts: AV, options: LOSSLESS_OPTS, lossless: true },
  { id: "alac", label: "ALAC", ext: "m4a", group: "audio", accepts: AV, options: LOSSLESS_OPTS, lossless: true },
  { id: "opus", label: "Opus", ext: "opus", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "ogg", label: "OGG", detail: "Vorbis", ext: "ogg", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "wma", label: "WMA", ext: "wma", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "ac3", label: "AC3", ext: "ac3", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "wavpack", label: "WavPack", ext: "wv", group: "audio", accepts: AV, options: LOSSLESS_OPTS, lossless: true },
  { id: "mp2", label: "MP2", ext: "mp2", group: "audio", accepts: AV, options: AUDIO_OPTS },
  { id: "jpeg", label: "JPEG", ext: "jpg", group: "image", accepts: ["image"], options: ["imageQuality", "maxSize"] },
  { id: "png", label: "PNG", ext: "png", group: "image", accepts: ["image"], options: ["maxSize"], lossless: true },
  { id: "webp", label: "WebP", ext: "webp", group: "image", accepts: ["image"], options: ["imageQuality", "maxSize"] },
  { id: "avif", label: "AVIF", ext: "avif", group: "image", accepts: ["image"], options: ["imageQuality", "maxSize"] },
  { id: "tiff", label: "TIFF", ext: "tiff", group: "image", accepts: ["image"], options: ["maxSize"], lossless: true },
  { id: "gif-image", label: "GIF", ext: "gif", group: "image", accepts: ["image"], options: ["maxSize"] },
  { id: "bmp", label: "BMP", ext: "bmp", group: "image", accepts: ["image"], options: ["maxSize"], lossless: true },
  { id: "ico", label: "ICO", detail: "Icon", ext: "ico", group: "image", accepts: ["image"], options: [] },
  { id: "pdf-image", label: "PDF", ext: "pdf", group: "image", accepts: ["image"], options: ["imageQuality", "maxSize"] },
]

const EXT_KIND: Record<string, Kind> = {}
for (const e of "mp3 wav opus flac m4a aac ogg oga wma aiff aif alac ac3 wv mp2 amr caf".split(" ")) EXT_KIND[e] = "audio"
for (const e of "mp4 mov mkv webm avi m4v wmv flv mpg mpeg 3gp mts m2ts ts ogv".split(" ")) EXT_KIND[e] = "video"
for (const e of "jpg jpeg png webp heic heif avif tif tiff gif bmp ico tga psd dng cr2 nef arw raf".split(" ")) EXT_KIND[e] = "image"
EXT_KIND.pdf = "pdf"
for (const e of "docx doc odt rtf txt md html".split(" ")) EXT_KIND[e] = "document"
for (const e of "ttf otf woff woff2 ttc".split(" ")) EXT_KIND[e] = "font"

/** Files dropped while running in a browser, so the mock can describe them. */
const mockFiles = new Map<string, File>()

export function registerBrowserFiles(files: File[]): string[] {
  return files.map((f) => {
    const path = `C:\\Users\\you\\Desktop\\${f.name}`
    mockFiles.set(path, f)
    return path
  })
}

/* -------------------------------------------------------------------------------------------------
 * API
 * -----------------------------------------------------------------------------------------------*/

let catalogCache: Promise<Target[]> | null = null

export function catalog(): Promise<Target[]> {
  catalogCache ??= inTauri ? invoke<Target[]>("catalog") : Promise.resolve(MOCK_TARGETS)
  return catalogCache
}

export async function engineStatus(): Promise<EngineStatus> {
  if (inTauri) return invoke<EngineStatus>("engine_status")
  return {
    ffmpeg: { path: "(browser preview)", version: "7.1", bundled: true },
    hwEncoders: ["h264_nvenc", "hevc_nvenc"],
    platform: "windows",
    shellMenu: false,
  }
}

export async function inspect(paths: string[]): Promise<FileInfo[]> {
  if (inTauri) return invoke<FileInfo[]>("inspect", { paths })
  return paths.map((path) => {
    const f = mockFiles.get(path)
    const ext = extname(path)
    const kind = EXT_KIND[ext] ?? "unknown"
    return {
      path,
      name: f?.name ?? path.split(/[\\/]/).pop()!,
      ext,
      size: f?.size ?? 4_200_000,
      kind,
      duration: kind === "audio" || kind === "video" ? 184 : undefined,
      problem: kind === "unknown" ? "Morf doesn't know this kind of file yet." : undefined,
    }
  })
}

/** Targets that every file in a selection can become. Video and audio mix, like Convert. */
export function targetsFor(all: Target[], kinds: Kind[]): Target[] {
  const set = new Set(kinds)
  if (set.size === 0) return []
  return all.filter((t) => [...set].every((k) => t.accepts.includes(k)))
}

const mockTimers = new Map<string, number>()
let mockListener: ((e: JobEvent) => void) | null = null

export async function startJob(req: JobRequest): Promise<void> {
  if (inTauri) return invoke("start_job", { req })
  // Simulated job: a few seconds of progress, then a plausible output.
  let p = 0
  const f = mockFiles.get(req.path)
  const size = f?.size ?? 4_200_000
  const timer = window.setInterval(() => {
    p += 0.04 + Math.random() * 0.06
    if (p >= 1) {
      window.clearInterval(timer)
      mockTimers.delete(req.jobId)
      const ratio = req.op === "compress" ? 0.18 + Math.random() * 0.2 : 0.6 + Math.random() * 0.6
      const ext = req.target ? MOCK_TARGETS.find((t) => t.id === req.target)?.ext ?? "out" : extname(req.path)
      mockListener?.({
        jobId: req.jobId,
        state: "done",
        progress: 1,
        output: req.path.replace(/\.[^.]+$/, req.op === "compress" ? ` (compressed).${ext}` : `.${ext}`),
        outSize: Math.round(size * ratio),
      })
    } else {
      mockListener?.({ jobId: req.jobId, state: "running", progress: p })
    }
  }, 160)
  mockTimers.set(req.jobId, timer)
}

export async function cancelJob(jobId: string): Promise<void> {
  if (inTauri) return invoke("cancel_job", { jobId })
  const t = mockTimers.get(jobId)
  if (t) window.clearInterval(t)
  mockTimers.delete(jobId)
  mockListener?.({ jobId, state: "stopped", progress: 0 })
}

export async function onJobEvent(cb: (e: JobEvent) => void): Promise<UnlistenFn> {
  if (inTauri) return listen<JobEvent>("morf://job", (e) => cb(e.payload))
  mockListener = cb
  return () => {
    if (mockListener === cb) mockListener = null
  }
}

export async function reveal(path: string): Promise<void> {
  if (!inTauri) return
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener")
  await revealItemInDir(path)
}

export async function pickFiles(): Promise<string[]> {
  if (!inTauri) return []
  const { open } = await import("@tauri-apps/plugin-dialog")
  const r = await open({ multiple: true, directory: false })
  return r ? (Array.isArray(r) ? r : [r]) : []
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return null
  const { open } = await import("@tauri-apps/plugin-dialog")
  const r = await open({ directory: true, multiple: false })
  return typeof r === "string" ? r : null
}

/**
 * Paths Morf was opened with (command line, right-click menu) and any handed over later by a
 * second launch. The engine buffers them; the window drains the buffer now and on each signal.
 */
export async function onOpenFiles(cb: (paths: string[], tool: string | null) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {}
  const drain = async () => {
    const pending = await invoke<{ paths: string[]; tool: string | null }>("take_launch_files")
    if (pending.paths.length) cb(pending.paths, pending.tool)
  }
  const off = await listen("morf://open", () => void drain())
  await drain()
  return off
}

export async function setShellMenu(enabled: boolean): Promise<boolean> {
  if (!inTauri) return enabled
  return invoke<boolean>("set_shell_menu", { enabled })
}

/** File-drop events from the window. The browser gives File objects, the app gives paths. */
export async function onWindowDrop(handlers: {
  over: (over: boolean) => void
  drop: (paths: string[]) => void
}): Promise<UnlistenFn> {
  if (inTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview")
    return getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === "enter" || p.type === "over") handlers.over(true)
      else if (p.type === "leave") handlers.over(false)
      else if (p.type === "drop") {
        handlers.over(false)
        handlers.drop(p.paths)
      }
    })
  }
  let depth = 0
  const enter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return
    e.preventDefault()
    depth++
    handlers.over(true)
  }
  const over = (e: DragEvent) => e.preventDefault()
  const leave = () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) handlers.over(false)
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    depth = 0
    handlers.over(false)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) handlers.drop(registerBrowserFiles(files))
  }
  window.addEventListener("dragenter", enter)
  window.addEventListener("dragover", over)
  window.addEventListener("dragleave", leave)
  window.addEventListener("drop", drop)
  return () => {
    window.removeEventListener("dragenter", enter)
    window.removeEventListener("dragover", over)
    window.removeEventListener("dragleave", leave)
    window.removeEventListener("drop", drop)
  }
}

/** A URL the webview can show for a local file (for before/after previews). */
export async function fileUrl(path: string): Promise<string | null> {
  if (inTauri) {
    const { convertFileSrc } = await import("@tauri-apps/api/core")
    return convertFileSrc(path)
  }
  const f = mockFiles.get(path)
  return f ? URL.createObjectURL(f) : null
}
