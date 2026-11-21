/**
 * The PDF tool's page work, all in the window: pdf.js draws pages, pdf-lib writes new files.
 * Passwords (Protect, Unlock) are done by the engine (`pdfsec.rs`).
 */
import type { PDFDocumentProxy } from "pdfjs-dist"
import { files as fileApi, inTauri } from "./engine"
import { extname } from "./utils"
import { invoke } from "@tauri-apps/api/core"

export const PDF_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif", "bmp", "tif", "tiff"]

let pdfjsReady: Promise<typeof import("pdfjs-dist")> | null = null
function pdfjs() {
  pdfjsReady ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs"
    return m
  })
  return pdfjsReady
}

/** Raw bytes are cached per path: pdf.js detaches the buffers it's given, so it always gets a copy. */
const bytesCache = new Map<string, Promise<ArrayBuffer>>()
export function pdfBytes(path: string): Promise<ArrayBuffer> {
  let p = bytesCache.get(path)
  if (!p) {
    p = fileApi.bytes(path)
    bytesCache.set(path, p)
    p.catch(() => bytesCache.delete(path))
  }
  return p
}
export function forget(path: string) {
  bytesCache.delete(path)
  docCache.delete(path)
}

export class LockedError extends Error {
  constructor() {
    super("This PDF needs a password. Unlock it first.")
  }
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>()
export function openPdf(path: string): Promise<PDFDocumentProxy> {
  let p = docCache.get(path)
  if (!p) {
    p = (async () => {
      const lib = await pdfjs()
      const data = new Uint8Array((await pdfBytes(path)).slice(0))
      try {
        return await lib.getDocument({ data }).promise
      } catch (e) {
        if ((e as { name?: string })?.name === "PasswordException") throw new LockedError()
        throw e
      }
    })()
    docCache.set(path, p)
    p.catch(() => docCache.delete(path))
  }
  return p
}

/** A page drawn `width` CSS pixels wide (sharp on high-DPI screens). Cached as an object URL. */
const thumbCache = new Map<string, Promise<string>>()
export function pageImage(path: string, page: number, width: number): Promise<string> {
  const key = `${path}#${page}@${width}`
  let p = thumbCache.get(key)
  if (!p) {
    p = (async () => {
      const doc = await openPdf(path)
      const pg = await doc.getPage(page)
      const base = pg.getViewport({ scale: 1 })
      const viewport = pg.getViewport({ scale: (width * Math.min(2, window.devicePixelRatio || 1)) / base.width })
      const canvas = document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await pg.render({ canvas, viewport }).promise
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"))
      return URL.createObjectURL(blob)
    })()
    thumbCache.set(key, p)
    p.catch(() => thumbCache.delete(key))
  }
  return p
}

/** Width ÷ height of a page as shown (rotation included). */
export async function pageAspect(path: string, page: number): Promise<number> {
  const pg = await (await openPdf(path)).getPage(page)
  const v = pg.getViewport({ scale: 1 })
  return v.width / v.height
}

const isImage = (path: string) => PDF_IMAGE_EXTS.includes(extname(path))

/** Any picture as bytes pdf-lib can embed: JPEG and PNG as they are, everything else as PNG. */
async function imageForPdf(path: string): Promise<{ bytes: Uint8Array; kind: "jpg" | "png"; w: number; h: number }> {
  const ext = extname(path)
  const url = await fileApi.previewUrl(path)
  if (!url) throw new Error("Morf can't read this picture.")
  const img = new Image()
  img.src = url
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (ext === "jpg" || ext === "jpeg") return { bytes: new Uint8Array(await fileApi.bytes(path)), kind: "jpg", w, h }
  if (ext === "png") return { bytes: new Uint8Array(await fileApi.bytes(path)), kind: "png", w, h }
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  c.getContext("2d")!.drawImage(img, 0, 0)
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"))
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: "png", w, h }
}

async function lib() {
  return import("pdf-lib")
}

async function loadForEdit(path: string) {
  const { PDFDocument } = await lib()
  try {
    return await PDFDocument.load(await pdfBytes(path), { updateMetadata: false })
  } catch (e) {
    if (String(e).toLowerCase().includes("encrypt")) throw new LockedError()
    throw e
  }
}

/** PDFs and pictures, in order, into one PDF. A picture becomes a page its own size. */
export async function merge(paths: string[], onStep?: (i: number) => void): Promise<Uint8Array> {
  const { PDFDocument } = await lib()
  const out = await PDFDocument.create()
  for (let i = 0; i < paths.length; i++) {
    onStep?.(i)
    const path = paths[i]
    if (isImage(path)) {
      const im = await imageForPdf(path)
      const embedded = im.kind === "jpg" ? await out.embedJpg(im.bytes) : await out.embedPng(im.bytes)
      // 96 dpi, the size a picture appears on screen.
      const w = im.w * 0.75
      const h = im.h * 0.75
      out.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h })
    } else {
      const src = await loadForEdit(path)
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p)
    }
  }
  return out.save()
}

/** "1-3, 5, 8-" → [[1,2,3],[5],[8…last]]. Pages are 1-based. Throws a friendly message. */
export function parseRanges(text: string, last: number): number[][] {
  const groups: number[][] = []
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part)
    let a: number
    let b: number
    if (m) {
      a = m[1] ? Number(m[1]) : 1
      b = m[2] ? Number(m[2]) : last
    } else if (/^\d+$/.test(part)) {
      a = b = Number(part)
    } else {
      throw new Error(`“${part}” isn't a page or a range, like 1-3.`)
    }
    if (a > b) throw new Error(`${part} runs backwards. Write the smaller page first, like ${b}-${a}.`)
    if (a < 1 || b > last) {
      const which = a === b ? `Page ${a} isn't` : `Pages ${part} aren't all`
      throw new Error(`${which} in this PDF, which has ${last} ${last === 1 ? "page" : "pages"}.`)
    }
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a + i))
  }
  if (!groups.length) throw new Error("Type the pages to keep, like 1-3, 5.")
  return groups
}

export function chunk(last: number, every: number): number[][] {
  const out: number[][] = []
  for (let a = 1; a <= last; a += every) out.push(Array.from({ length: Math.min(every, last - a + 1) }, (_, i) => a + i))
  return out
}

export function rangeLabel(pages: number[]): string {
  if (pages.length === 1) return `page ${pages[0]}`
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1)
  return contiguous ? `pages ${pages[0]}-${pages[pages.length - 1]}` : `pages ${pages.join(", ")}`
}

/** A new PDF with these pages (1-based) of `path`, each turned by `turn` degrees (multiple of 90). */
export async function pick(path: string, pages: { page: number; turn?: number }[]): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await lib()
  const src = await loadForEdit(path)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(
    src,
    pages.map((p) => p.page - 1),
  )
  copied.forEach((pg, i) => {
    const turn = pages[i].turn ?? 0
    if (turn) pg.setRotation(degrees((((pg.getRotation().angle + turn) % 360) + 360) % 360))
    out.addPage(pg)
  })
  return out.save()
}

/** Where a signature sits, as fractions of the page as shown (0…1 from the top-left). */
export interface Placement {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** Draws the signature picture onto each placement and returns the whole document. */
export async function sign(path: string, signaturePng: Uint8Array, placements: Placement[]): Promise<Uint8Array> {
  const { degrees } = await lib()
  const doc = await loadForEdit(path)
  const image = await doc.embedPng(signaturePng)
  const view = await openPdf(path)
  for (const pl of placements) {
    const shown = await view.getPage(pl.page)
    // pdf.js knows how the page is shown (crop box and rotation); let it map the corner back.
    const v = shown.getViewport({ scale: 1 })
    const [x, y] = v.convertToPdfPoint(pl.x * v.width, (pl.y + pl.h) * v.height)
    doc.getPage(pl.page - 1).drawImage(image, {
      x,
      y,
      width: pl.w * v.width,
      height: pl.h * v.height,
      rotate: degrees(shown.rotate),
    })
  }
  return doc.save()
}

/** Engine side: passwords. */
export const pdfPasswords = {
  protect: (req: { path: string; password: string; allowPrint: boolean; allowCopy: boolean; allowEdit: boolean }): Promise<string> =>
    inTauri ? invoke("pdf_protect", { req }) : Promise.resolve(req.path.replace(/\.pdf$/i, " (protected).pdf")),
  unlock: (path: string, password: string): Promise<string> =>
    inTauri ? invoke("pdf_unlock", { path, password }) : Promise.resolve(path.replace(/\.pdf$/i, " (unlocked).pdf")),
  needsPassword: (path: string): Promise<boolean> => (inTauri ? invoke("pdf_needs_password", { path }) : Promise.resolve(false)),
}

/** A new folder beside `path` for many outputs. In the browser preview, a pretend path. */
export async function folderBeside(path: string, suffix: string): Promise<string> {
  if (!inTauri) return path.replace(/\.[^.\\/]+$/, suffix)
  return invoke("folder_beside", { beside: path, suffix })
}
