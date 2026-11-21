import { useEffect, useRef, useState } from "react"
import { ArrowUpRight } from "lucide-react"
import type { InferenceSession } from "onnxruntime-web"
import { ToolHeader } from "@/components/files"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSwitch } from "@/components/ui/settings-panel"
import { dictation, files as fileApi, onWindowDrop, pickFiles } from "@/lib/engine"
import { announceSaved } from "@/lib/saved"
import { cn, formatBytes } from "@/lib/utils"

const SIZE = 1024
let session: Promise<{ s: InferenceSession; ort: typeof import("onnxruntime-web") }> | null = null

/** Loads ISNet once. WebGPU when the graphics card allows it, WebAssembly otherwise. */
function getSession(modelPath: string) {
  session ??= (async () => {
    const ort = await import("onnxruntime-web/webgpu")
    // Only the .wasm comes from Morf's files; the bundle carries its own loader.
    ort.env.wasm.wasmPaths = { wasm: new URL("/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm", location.href).href }
    ort.env.wasm.numThreads = 1
    const bytes = new Uint8Array(await fileApi.bytes(modelPath))
    let s: InferenceSession
    try {
      s = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] })
    } catch {
      s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] })
    }
    return { s, ort: ort as unknown as typeof import("onnxruntime-web") }
  })()
  session.catch(() => (session = null))
  return session
}

/** Runs ISNet (rembg's preprocessing: 1024², divide by the max, subtract ImageNet means). */
async function predictMask(img: HTMLImageElement, modelPath: string): Promise<Uint8ClampedArray> {
  const { s, ort } = await getSession(modelPath)
  const c = document.createElement("canvas")
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, SIZE, SIZE)
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data
  let max = 1
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2])
  const mean = [0.485, 0.456, 0.406]
  const input = new Float32Array(3 * SIZE * SIZE)
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    for (let ch = 0; ch < 3; ch++) input[ch * SIZE * SIZE + p] = px[i + ch] / max - mean[ch]
  }
  const feeds = { [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) }
  const out = await s.run(feeds)
  const pred = out[s.outputNames[0]].data as Float32Array
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < SIZE * SIZE; i++) {
    lo = Math.min(lo, pred[i])
    hi = Math.max(hi, pred[i])
  }
  const mask = new Uint8ClampedArray(SIZE * SIZE)
  for (let i = 0; i < SIZE * SIZE; i++) mask[i] = ((pred[i] - lo) / (hi - lo || 1)) * 255
  return mask
}

function maskToPng(mask: Uint8ClampedArray): Promise<Uint8Array> {
  const c = document.createElement("canvas")
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext("2d")!
  const data = ctx.createImageData(SIZE, SIZE)
  for (let i = 0; i < mask.length; i++) {
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = mask[i]
    data.data[i * 4 + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return new Promise((r) => c.toBlob(async (b) => r(new Uint8Array(await b!.arrayBuffer())), "image/png"))
}

export function CutoutScreen() {
  const [model, setModel] = useState<{ path: string | null; size: number } | null>(null)
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null)
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null)
  const [mask, setMask] = useState<Uint8ClampedArray | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [crop, setCrop] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [split, setSplit] = useState(100)
  const canvas = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    void fileApi.cutoutModel().then(setModel)
    let off: (() => void) | undefined
    void dictation
      .onDownload((e) => {
        if (e.id !== "cutout") return
        if (e.state === "downloading") setDownload({ received: e.received, total: e.total })
        else {
          setDownload(null)
          if (e.state === "failed") setError(e.error ?? "The download failed.")
          void fileApi.cutoutModel().then(setModel)
        }
      })
      .then((u) => (off = u))
    return () => off?.()
  }, [])

  const process = async (path: string) => {
    if (!model?.path) return
    setError(null)
    setMask(null)
    setSplit(100)
    try {
      const url = await fileApi.previewUrl(path)
      if (!url) throw new Error("Morf can't open this picture.")
      setSrc({ path, url })
      const img = new Image()
      img.src = url
      await img.decode()
      imgRef.current = img
      setBusy(session ? "Finding the subject…" : "Starting the model…")
      const m = await predictMask(img, model.path)
      setMask(m)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => p[0] && void process(p[0]) }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // Draw the preview: the cut-out subject over a checkerboard.
  useEffect(() => {
    const c = canvas.current
    const img = imgRef.current
    if (!c || !img || !mask) return
    const s = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight))
    c.width = Math.round(img.naturalWidth * s)
    c.height = Math.round(img.naturalHeight * s)
    const ctx = c.getContext("2d")!
    const m = document.createElement("canvas")
    m.width = SIZE
    m.height = SIZE
    const mctx = m.getContext("2d")!
    const md = mctx.createImageData(SIZE, SIZE)
    for (let i = 0; i < mask.length; i++) md.data[i * 4 + 3] = mask[i]
    mctx.putImageData(md, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    ctx.globalCompositeOperation = "destination-in"
    ctx.drawImage(m, 0, 0, c.width, c.height)
    ctx.globalCompositeOperation = "source-over"
  }, [mask])

  const choose = async () => {
    const [p] = await pickFiles([{ name: "Photos", extensions: ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "tif", "tiff", "bmp"] }], false)
    if (p) void process(p)
  }

  if (!model) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="Cutout">
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Remove the background from a photo. A local model finds the subject; the result is a transparent PNG.</p>
      </ToolHeader>

      {!model.path ? (
        <div className="flex flex-1 flex-col justify-between border-t border-hair p-5">
          <span className="label text-ink-4">One-time setup</span>
          <div className="flex max-w-xl flex-col gap-5">
            <p className="display text-[clamp(48px,6vw,88px)]">Get the model.</p>
            <p className="text-[15px]/[24px] text-ink-2">
              Cutout uses ISNet, an open model ({formatBytes(model.size)}, Apache 2.0). Morf downloads it once and checks it; after that, Cutout works offline and nothing you cut out leaves this computer.
            </p>
            {download ? (
              <div className="flex items-center gap-4">
                <div className="relative h-px flex-1 bg-hair">
                  <div className="absolute inset-y-0 left-0 bg-ink transition-[width]" style={{ width: `${(download.received / Math.max(1, download.total)) * 100}%` }} />
                </div>
                <span className="label text-ink tabular-nums">{Math.round((download.received / Math.max(1, download.total)) * 100)}%</span>
                <Button size="sm" variant="ghost" onClick={() => void dictation.cancelDownload()}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="xl"
                variant="solid"
                className="w-fit"
                onClick={() => {
                  setDownload({ received: 0, total: model.size })
                  void fileApi.downloadCutoutModel()
                }}
              >
                Download model
              </Button>
            )}
            {error ? <p className="text-[13px] text-signal">{error}</p> : null}
          </div>
        </div>
      ) : (
        <div className={cn("grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair transition-colors", dragging && "bg-paper-2")}>
          <section className={cn("relative col-span-8 flex min-h-0 items-center justify-center", src ? "p-6" : "px-5 pt-6 pb-6")}>
            {src && mask ? (
              <div className="relative max-h-full max-w-full" onPointerMove={(e) => e.buttons === 1 && setSplit(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width) * 100)}>
                <div className="checker absolute inset-0 rounded-xl" />
                <canvas ref={canvas} className="relative max-h-[calc(100vh-280px)] max-w-full rounded-xl object-contain" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
                <img src={src.url} alt="" className="absolute inset-0 size-full rounded-xl object-contain" style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
                {split < 100 ? <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${split}%` }} /> : null}
              </div>
            ) : src ? (
              <div className="relative">
                <img src={src.url} alt="" className="max-h-[calc(100vh-280px)] max-w-full rounded-xl object-contain opacity-50" />
                <div className="label absolute inset-0 grid place-items-center text-ink">{busy}</div>
              </div>
            ) : (
              // Empty: the same drop target as the other file tools.
              <div className="flex h-full w-full flex-col justify-between">
                <div className="label flex justify-between text-ink-4">
                  <span>JPEG · PNG · WebP · HEIC</span>
                  <span>Nothing leaves this computer</span>
                </div>
                <div className="flex flex-col gap-5">
                  <p className={cn("display text-[clamp(56px,8vw,140px)] transition-colors duration-300", dragging ? "text-ink" : "text-ghost")}>{dragging ? "Let go" : "Drop a photo"}</p>
                  <button onClick={() => void choose()} className="focus-ring group flex w-fit items-center gap-1.5 pl-1 text-[15px] font-medium tracking-[-0.01em] text-ink">
                    <span className="underline decoration-hair-strong underline-offset-4 transition-colors group-hover:decoration-ink">or choose a photo</span>
                    <ArrowUpRight size={15} strokeWidth={1.5} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </button>
                </div>
              </div>
            )}
          </section>
          <section className="col-span-4 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 text-ink-4">
                <span>Result</span>
                {src && !busy ? (
                  <button className="focus-ring transition-colors hover:text-ink" onClick={() => void choose()}>
                    Choose another
                  </button>
                ) : null}
              </div>
              {error ? <p className="mb-3 text-[13px]/[19px] text-signal">{error}</p> : null}
              {mask ? (
                <div className="divide-y divide-hair border-t border-hair">
                  <SettingsRow label="Trim to the subject" description="Removes the empty border around it.">
                    <SettingsSwitch checked={crop} onCheckedChange={setCrop} />
                  </SettingsRow>
                  <SettingsRow label="Compare" description="Drag across the picture, or use the slider.">
                    <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="morf-range w-32" style={{ "--pct": `${split}%` } as React.CSSProperties} />
                  </SettingsRow>
                </div>
              ) : (
                <p className="text-[13px]/[19px] text-ink-3">{busy ?? (src ? "" : "The subject is found on this computer. People, products and pets work best.")}</p>
              )}
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-hair px-5 py-4">
              <span className="label min-w-0 truncate text-ink-4">PNG · original kept</span>
              <Button
                size="xl"
                variant="solid"
                disabled={!mask || !!busy}
                onClick={async () => {
                  if (!src || !mask) return
                  setBusy("Saving…")
                  try {
                    const out = await fileApi.applyCutout(src.path, await maskToPng(mask), crop)
                    announceSaved("Cutout", [{ path: out }])
                  } catch (e) {
                    setError(String(e))
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy === "Saving…" ? "Saving…" : "Save"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
