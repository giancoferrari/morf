import { useEffect, useRef, useState } from "react"
import type { Worker as TessWorker } from "tesseract.js"
import { ToolHeader } from "@/components/files"
import { FitText } from "@/components/FitText"
import { Select } from "@/components/options"
import { Button } from "@/components/ui/button"
import { files as fileApi, onWindowDrop, pickFiles } from "@/lib/engine"
import { takeHandoff } from "@/lib/handoff"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { announceSaved } from "@/lib/saved"
import { basename, cn, extname } from "@/lib/utils"

const LANGS: [string, string][] = [
  ["eng", "English"],
  ["spa", "Spanish"],
  ["ita", "Italian"],
  ["fra", "French"],
  ["deu", "German"],
  ["por", "Portuguese"],
  ["nld", "Dutch"],
]

let worker: { lang: string; w: Promise<TessWorker> } | null = null

/** One Tesseract worker, kept warm. English ships with Morf; other languages download once. */
async function getWorker(lang: string, onProgress: (p: number) => void) {
  if (worker?.lang !== lang) {
    if (worker) void (await worker.w).terminate()
    const { createWorker } = await import("tesseract.js")
    const local = lang === "eng"
    worker = {
      lang,
      w: createWorker(lang, 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract/core",
        langPath: local ? "/vendor/tesseract/lang" : `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`,
        gzip: true,
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") onProgress(m.progress)
        },
      }),
    }
  }
  return worker.w
}

async function pdfPages(bytes: ArrayBuffer, onPage: (i: number, n: number) => void): Promise<{ text: string; images: HTMLCanvasElement[] }> {
  const pdfjs = await import("pdfjs-dist")
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs"
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  const texts: string[] = []
  const images: HTMLCanvasElement[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    onPage(i, doc.numPages)
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("").trim()
    if (text.length > 20) {
      texts.push(text)
      continue
    }
    // No text layer: a scan. Render at ~200 dpi for recognition.
    const viewport = page.getViewport({ scale: 2.8 })
    const canvas = document.createElement("canvas")
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, viewport }).promise
    images.push(canvas)
    texts.push(`\u0000${images.length - 1}`)
  }
  return { text: texts.join("\n\n"), images }
}

const kept: { source: { path: string; url: string | null } | null; text: string } = { source: null, text: "" }

export function ReadScreen() {
  const [source, setSource] = useState<{ path: string; url: string | null } | null>(() => kept.source)
  const [text, setText] = useState(() => kept.text)
  // Kept for the session, so the text is still here after a trip to another tool.
  useEffect(() => {
    kept.source = source
    kept.text = text
  }, [source, text])
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [lang, setLang] = useState<string>(() => loadJSON("read.lang", "eng"))
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const run = useRef(0)

  const recognize = async (path: string) => {
    const id = ++run.current
    setError(null)
    setText("")
    setProgress(0)
    try {
      if (extname(path) === "pdf") {
        setSource({ path, url: null })
        setBusy("Reading the PDF…")
        const { text: t, images } = await pdfPages(await fileApi.bytes(path), (i, n) => setBusy(`Page ${i} of ${n}…`))
        let out = t
        if (images.length) {
          const w = await getWorker(lang, setProgress)
          for (let i = 0; i < images.length; i++) {
            if (id !== run.current) return
            setBusy(`Recognising scanned page ${i + 1} of ${images.length}…`)
            const r = await w.recognize(images[i])
            out = out.replace(`\u0000${i}`, r.data.text.trim())
          }
        }
        if (id === run.current) setText(out.trim())
      } else {
        const url = await fileApi.previewUrl(path)
        setSource({ path, url })
        setBusy(lang === "eng" ? "Recognising text…" : "Getting the language ready…")
        const w = await getWorker(lang, setProgress)
        setBusy("Recognising text…")
        const r = await w.recognize(url!)
        if (id === run.current) setText(r.data.text.trim())
      }
    } catch (e) {
      setError(String(e))
    } finally {
      if (id === run.current) setBusy(null)
    }
  }

  // A file handed over from the index or the right-click menu.
  useEffect(() => {
    const [waiting] = takeHandoff("ocr")
    if (waiting) void recognize(waiting)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => p[0] && void recognize(p[0]) }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  // Ctrl+V with a screenshot on the clipboard reads it straight away.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"))
      if (!item) return
      e.preventDefault()
      const url = URL.createObjectURL(item.getAsFile()!)
      setSource({ path: "", url })
      setBusy("Recognising text…")
      try {
        const w = await getWorker(lang, setProgress)
        setText((await w.recognize(url)).data.text.trim())
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(null)
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [lang])

  const words = (text.match(/\S+/g) ?? []).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader
        title="Read"
        meta={
          text ? (
            <span className="label text-ink-3">
              <span className="text-ink">{words}</span> words
            </span>
          ) : null
        }
      >
        <div className="flex flex-col gap-3">
          <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Pull the text out of photos, screenshots and scanned PDFs. Recognition runs on this computer.</p>
          <div className="flex items-center gap-3">
            <span className="label text-ink-4">Language</span>
            <Select
              aria-label="Language"
              value={lang}
              onChange={(v) => {
                setLang(v)
                saveJSON("read.lang", v)
              }}
              options={LANGS.map(([value, label]) => ({ value, label: value === "eng" ? label : `${label} (downloads once)` }))}
            />
          </div>
        </div>
      </ToolHeader>

      <div className={cn("grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair transition-colors", dragging && "bg-paper-2")}>
        <section className="col-span-5 flex min-h-0 flex-col gap-4 p-5">
          {source?.url ? (
            <img src={source.url} alt="" className="anim-fade min-h-0 flex-1 rounded-xl object-contain object-top" />
          ) : source ? (
            <FitText className="display anim-fade" max={64} min={22} title={source.path}>
              {basename(source.path)}
            </FitText>
          ) : (
            <p className={cn("display text-[clamp(52px,6.5vw,104px)] transition-colors", dragging ? "text-ink" : "text-ghost")}>{dragging ? "Let go" : "Drop a picture or PDF"}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              variant={source ? "outline" : "solid"}
              disabled={!!busy}
              onClick={async () => {
                const [p] = await pickFiles()
                if (p) void recognize(p)
              }}
            >
              Choose file
            </Button>
            <span className="label text-ink-4">or paste a screenshot with {navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} V</span>
          </div>
        </section>

        <section className="col-span-7 flex min-h-0 flex-col border-l border-hair">
          <div className="label flex items-center justify-between px-5 py-3 text-ink-4">
            <span>{busy ?? "Text"}</span>
            {busy && progress > 0 && progress < 1 ? <span className="text-ink tabular-nums">{Math.round(progress * 100)}%</span> : null}
          </div>
          {busy ? (
            <div className="relative mx-5 h-px bg-hair">
              <div className="absolute inset-y-0 left-0 bg-ink transition-[width]" style={{ width: `${Math.max(4, progress * 100)}%` }} />
            </div>
          ) : null}
          {error ? <p className="px-5 pt-3 text-[13px] text-signal">{error}</p> : null}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={busy ? "" : "The text will appear here, ready to edit and copy."}
            className="scroll-quiet min-h-0 flex-1 resize-none bg-transparent px-5 py-4 text-[16px]/[27px] text-ink outline-none placeholder:text-ghost"
          />
          <div className="flex items-center justify-end gap-2 border-t border-hair px-5 py-4">
            <Button
              size="lg"
              variant="ghost"
              disabled={!text}
              onClick={async () => {
                await navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }}
            >
              {copied ? "Copied" : "Copy text"}
            </Button>
            <Button
              size="xl"
              variant="solid"
              disabled={!text}
              onClick={async () => {
                const saved = source?.path ? await fileApi.saveBeside(source.path, " (text)", "txt", text) : await fileApi.saveAs("text.txt", text, [{ name: "Text", extensions: ["txt"] }])
                if (saved) announceSaved("Read", [{ path: saved }], `${words} words`)
              }}
            >
              Save as text file
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
