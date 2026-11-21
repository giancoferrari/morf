/**
 * A file queue per tool (Convert, Compress). Kept outside React so it survives moving between
 * screens, and so one listener can route engine events to whichever queue owns the job.
 */
import { useSyncExternalStore } from "react"
import {
  cancelJob,
  inspect,
  onJobEvent,
  startJob,
  type FileInfo,
  type JobSettings,
  type JobState,
} from "./engine"
import { getPrefs } from "./prefs"
import { announceSaved } from "./saved"

export interface QueueItem {
  id: string
  file: FileInfo
  state: JobState | "idle"
  progress: number
  output?: string
  outSize?: number
  fallback?: boolean
  error?: string
}

export type QueueOp = "convert" | "compress" | "resize"

interface QueueState {
  items: QueueItem[]
  running: boolean
}

const stores: Record<QueueOp, QueueState> = {
  convert: { items: [], running: false },
  compress: { items: [], running: false },
  resize: { items: [], running: false },
}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function set(op: QueueOp, next: Partial<QueueState>) {
  stores[op] = { ...stores[op], ...next }
  emit()
}

function patchItem(op: QueueOp, id: string, patch: Partial<QueueItem>) {
  set(op, { items: stores[op].items.map((it) => (it.id === id ? { ...it, ...patch } : it)) })
}

let seq = 0
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/** jobId → op and the resolver that lets the batch runner wait for that job. */
const waiting = new Map<string, { op: QueueOp; resolve: () => void }>()

let wired = false
function wire() {
  if (wired) return
  wired = true
  void onJobEvent((e) => {
    const w = waiting.get(e.jobId)
    if (!w) return
    patchItem(w.op, e.jobId, {
      state: e.state,
      progress: e.progress,
      output: e.output,
      outSize: e.outSize,
      fallback: e.fallback,
      error: e.error,
    })
    if (e.state === "done" || e.state === "failed" || e.state === "stopped") {
      waiting.delete(e.jobId)
      w.resolve()
    }
  })
}

export async function addPaths(op: QueueOp, paths: string[]) {
  wire()
  const known = new Set(stores[op].items.map((i) => i.file.path))
  const fresh = paths.filter((p) => !known.has(p))
  if (!fresh.length) return
  const infos = await inspect(fresh)
  const items: QueueItem[] = infos.map((file) => ({ id: newId(), file, state: "idle", progress: 0 }))
  // A new drop after a finished batch starts a fresh list rather than piling on.
  const keep = stores[op].items.every((i) => i.state === "done" || i.state === "failed" || i.state === "stopped")
    ? []
    : stores[op].items
  set(op, { items: [...keep, ...items] })
}

export function removeItem(op: QueueOp, id: string) {
  set(op, { items: stores[op].items.filter((i) => i.id !== id) })
}

export function clearQueue(op: QueueOp) {
  if (stores[op].running) return
  set(op, { items: [] })
}

/** Runs the batch one file at a time: hardware encoders and disks do best with one job. */
export async function runQueue(op: QueueOp, build: (item: QueueItem) => { target?: string; settings: JobSettings } | null) {
  wire()
  if (stores[op].running) return
  set(op, { running: true })
  const prefs = getPrefs()
  try {
    // Re-running a finished list runs it again from the top.
    for (const it of stores[op].items) {
      if (it.state !== "idle" && it.state !== "queued") patchItem(op, it.id, { state: "idle", progress: 0, error: undefined, output: undefined, outSize: undefined })
    }
    const ids = stores[op].items.filter((i) => !i.file.problem).map((i) => i.id)
    ids.forEach((id) => patchItem(op, id, { state: "queued" }))
    for (const id of ids) {
      if (!stores[op].running) break
      const item = stores[op].items.find((i) => i.id === id)
      if (!item) continue
      const job = build(item)
      if (!job) {
        patchItem(op, id, { state: "failed", error: "No format for this file." })
        continue
      }
      patchItem(op, id, { state: "running", progress: 0 })
      await new Promise<void>((resolve) => {
        waiting.set(id, { op, resolve })
        startJob({
          jobId: id,
          op,
          path: item.file.path,
          target: job.target,
          settings: job.settings,
          outDir: prefs.outputMode === "folder" ? prefs.outputFolder : null,
          trashOriginal: prefs.trashOriginals,
        }).catch((err) => {
          waiting.delete(id)
          patchItem(op, id, { state: "failed", error: String(err) })
          resolve()
        })
      })
    }
  } finally {
    // Anything never reached goes back to idle.
    set(op, {
      running: false,
      items: stores[op].items.map((i) => (i.state === "queued" ? { ...i, state: "idle" } : i)),
    })
    announceBatch(op)
  }
}

/** Tells the person where this batch's files went, with a one-line summary. */
function announceBatch(op: QueueOp) {
  const items = stores[op].items
  const done = items.filter((i) => i.state === "done" && i.output)
  const failed = items.filter((i) => i.state === "failed").length
  const parts: string[] = []
  if (op === "compress" && done.length) {
    const before = done.reduce((n, i) => n + i.file.size, 0)
    const after = done.reduce((n, i) => n + (i.outSize ?? 0), 0)
    if (before > 0) parts.push(`${Math.round((1 - after / before) * 100)}% smaller overall`)
  }
  const verb = { convert: "converted", compress: "compressed", resize: "resized" }[op]
  if (failed) parts.push(`${failed} ${failed === 1 ? "file" : "files"} couldn't be ${verb}`)
  announceSaved(
    { convert: "Convert", compress: "Compress", resize: "Resize" }[op],
    done.map((i) => ({ path: i.output!, size: i.outSize })),
    parts.join(" · ") || undefined,
  )
}

export async function stopQueue(op: QueueOp) {
  set(op, { running: false })
  const live = stores[op].items.filter((i) => i.state === "running")
  await Promise.all(live.map((i) => cancelJob(i.id)))
}

export function useQueue(op: QueueOp): QueueState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => stores[op],
  )
}
