import { useEffect, useState } from "react"
import { Check, Copy, Pipette } from "lucide-react"
import { ToolHeader } from "@/components/files"
import { Range } from "@/components/options"
import { Button } from "@/components/ui/button"
import { contrast, distinctPalette, formats, hex, parseHex, shades, type RGB } from "@/lib/color"
import { files as fileApi, onWindowDrop, pickFiles } from "@/lib/engine"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { announceSaved } from "@/lib/saved"
import { cn } from "@/lib/utils"

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
  }
}

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  return {
    copied,
    copy: async (key: string, text: string) => {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
    },
  }
}

export function PaletteScreen() {
  const [color, setColor] = useState<RGB>(() => parseHex(loadJSON("palette.current", "#D9481C")) ?? [217, 72, 28])
  const [history, setHistory] = useState<string[]>(() => loadJSON("palette.history", []))
  const [image, setImage] = useState<{ url: string; path: string } | null>(null)
  const [count, setCount] = useState(6)
  const [palette, setPalette] = useState<{ rgb: RGB; share: number }[]>([])
  const [dragging, setDragging] = useState(false)
  const [hexInput, setHexInput] = useState(hex(color))
  const { copied, copy } = useCopy()

  const choose = (rgb: RGB, remember = true) => {
    setColor(rgb)
    setHexInput(hex(rgb))
    saveJSON("palette.current", hex(rgb))
    if (remember)
      setHistory((h) => {
        const next = [hex(rgb), ...h.filter((x) => x !== hex(rgb))].slice(0, 24)
        saveJSON("palette.history", next)
        return next
      })
  }

  const pick = async () => {
    if (!window.EyeDropper) return
    try {
      const r = await new window.EyeDropper().open()
      const rgb = parseHex(r.sRGBHex)
      if (rgb) choose(rgb)
    } catch {
      /* cancelled */
    }
  }

  const loadImage = async (path: string) => {
    const url = await fileApi.previewUrl(path)
    if (url) setImage({ url, path })
  }

  useEffect(() => {
    if (!image) return
    let cancelled = false
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.src = image.url
    void img.decode().then(() => {
      const s = Math.min(1, 220 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement("canvas")
      c.width = Math.max(1, Math.round(img.naturalWidth * s))
      c.height = Math.max(1, Math.round(img.naturalHeight * s))
      const ctx = c.getContext("2d", { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, c.width, c.height)
      const p = distinctPalette(ctx.getImageData(0, 0, c.width, c.height).data, count)
      if (!cancelled) setPalette(p)
    })
    return () => {
      cancelled = true
    }
  }, [image, count])

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => p[0] && void loadImage(p[0]) }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
  }, [])

  const fmts = formats(color)
  const onWhite = contrast(color, WHITE)
  const onBlack = contrast(color, BLACK)
  const grade = (r: number) => (r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "AA large" : "Fails")
  const textOn = onWhite > onBlack ? "#ffffff" : "#111111"

  const savePaletteImage = async () => {
    const c = document.createElement("canvas")
    const w = 240
    c.width = palette.length * w
    c.height = 360
    const ctx = c.getContext("2d")!
    palette.forEach((p, i) => {
      ctx.fillStyle = hex(p.rgb)
      ctx.fillRect(i * w, 0, w, 280)
      ctx.fillStyle = "#f6f5f1"
      ctx.fillRect(i * w, 280, w, 80)
      ctx.fillStyle = "#111111"
      ctx.font = "500 22px 'Geist Mono Variable', monospace"
      ctx.fillText(hex(p.rgb), i * w + 20, 328)
    })
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const saved = image ? await fileApi.saveBeside(image.path, " (palette)", "png", bytes) : await fileApi.saveAs("palette.png", bytes)
    if (saved) announceSaved("Palette", [{ path: saved }])
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="Palette">
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Pick any colour on your screen, or pull the main colours out of a picture.</p>
      </ToolHeader>

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
        {/* The current colour */}
        <section className="scroll-quiet col-span-6 min-h-0 overflow-y-auto pl-5 pb-8">
          <div className="mt-5 flex aspect-[16/9] w-full flex-col justify-between rounded-2xl p-6 transition-colors duration-300" style={{ background: hex(color), color: textOn }}>
            <div className="flex items-center justify-between">
              <span className="label opacity-80">Colour</span>
              <Button size="md" variant="subtle" onClick={() => void pick()} disabled={!window.EyeDropper} className="bg-black/10 text-current hover:bg-black/20">
                <Pipette /> Pick from screen
              </Button>
            </div>
            <input
              value={hexInput}
              onChange={(e) => {
                setHexInput(e.target.value)
                const rgb = parseHex(e.target.value)
                if (rgb) choose(rgb, false)
              }}
              onBlur={() => choose(color)}
              spellCheck={false}
              className="display w-full bg-transparent text-[clamp(56px,7vw,104px)] text-current outline-none"
              aria-label="Hex colour"
            />
          </div>

          <ul className="mt-4 flex flex-col">
            {fmts.map((f) => (
              <li key={f.label} className="group flex items-center justify-between border-b border-hair py-2.5">
                <span className="label w-16 text-ink-4">{f.label}</span>
                <span className="flex-1 font-mono text-[13px] text-ink select-text">{f.value}</span>
                <button onClick={() => void copy(f.label, f.value)} className="focus-ring grid size-7 place-items-center rounded-lg text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-paper-2 hover:text-ink" aria-label={`Copy ${f.label}`}>
                  {copied === f.label ? <Check size={14} /> : <Copy size={14} strokeWidth={1.75} />}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-6 grid grid-cols-2 gap-3">
            {[
              { bg: "#ffffff", fg: hex(color), ratio: onWhite, label: "On white" },
              { bg: "#111111", fg: hex(color), ratio: onBlack, label: "On black" },
            ].map((c) => (
              <div key={c.label} className="flex items-center justify-between rounded-xl px-4 py-3 ring-1 ring-hair" style={{ background: c.bg }}>
                <span className="text-[22px] font-[560] tracking-[-0.02em]" style={{ color: c.fg }}>
                  Aa
                </span>
                <span className="label text-right" style={{ color: c.bg === "#ffffff" ? "#666" : "#aaa" }}>
                  {c.label}
                  <br />
                  {c.ratio.toFixed(2)} · {grade(c.ratio)}
                </span>
              </div>
            ))}
          </div>

          <div className="label mt-6 mb-2 text-ink-4">Tints and shades</div>
          <div className="flex overflow-hidden rounded-xl">
            {shades(color).map((s, i) => (
              <button key={i} onClick={() => choose(s)} title={hex(s)} className="focus-ring h-12 flex-1 transition-transform hover:z-10 hover:scale-y-110" style={{ background: hex(s) }} />
            ))}
          </div>

          {history.length ? (
            <>
              <div className="label mt-6 mb-2 flex justify-between text-ink-4">
                <span>Picked before</span>
                <button
                  className="focus-ring transition-colors hover:text-ink"
                  onClick={() => {
                    setHistory([])
                    saveJSON("palette.history", [])
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {history.map((h) => (
                  <button key={h} onClick={() => choose(parseHex(h)!, false)} title={h} className={cn("focus-ring size-8 rounded-full ring-1 ring-hair", h === hex(color) && "ring-2 ring-ink")} style={{ background: h }} />
                ))}
              </div>
            </>
          ) : null}
        </section>

        {/* From an image */}
        <section className={cn("scroll-quiet col-span-6 min-h-0 overflow-y-auto border-l border-hair px-5 pb-8 transition-colors", dragging && "bg-paper-2")}>
          <div className="label flex items-center justify-between py-3 text-ink-4">
            <span>From a picture</span>
            <button
              className="focus-ring transition-colors hover:text-ink"
              onClick={async () => {
                const [p] = await pickFiles()
                if (p) void loadImage(p)
              }}
            >
              Choose
            </button>
          </div>
          {image ? (
            <>
              <img src={image.url} alt="" className="anim-fade max-h-[38vh] w-full rounded-xl object-contain" />
              <div className="mt-4 flex h-28 overflow-hidden rounded-xl">
                {palette.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => choose(p.rgb)}
                    className="focus-ring group relative flex flex-col justify-end p-2 text-left transition-[flex-grow] duration-300"
                    style={{ background: hex(p.rgb), flexGrow: Math.max(0.6, p.share * 10) }}
                    title={`${hex(p.rgb)} · ${Math.round(p.share * 100)}%`}
                  >
                    <span className="label opacity-0 transition-opacity group-hover:opacity-100" style={{ color: contrast(p.rgb, WHITE) > contrast(p.rgb, BLACK) ? "#fff" : "#111" }}>
                      {hex(p.rgb)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-4">
                <span className="label text-ink-4">Colours</span>
                <Range aria-label="Number of colours" value={count} min={3} max={12} onChange={setCount} />
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button size="md" variant="solid" onClick={() => void savePaletteImage()} disabled={!palette.length}>
                  Save palette image
                </Button>
                <Button size="md" variant="outline" onClick={() => void copy("hexes", palette.map((p) => hex(p.rgb)).join(", "))}>
                  {copied === "hexes" ? "Copied" : "Copy HEX list"}
                </Button>
                <Button size="md" variant="ghost" onClick={() => void copy("css", palette.map((p, i) => `--color-${i + 1}: ${hex(p.rgb)};`).join("\n"))}>
                  {copied === "css" ? "Copied" : "Copy as CSS"}
                </Button>
              </div>
            </>
          ) : (
            <p className={cn("display pt-6 text-[clamp(48px,6vw,88px)] transition-colors", dragging ? "text-ink" : "text-ghost")}>{dragging ? "Let go" : "Drop a picture"}</p>
          )}
        </section>
      </div>
    </div>
  )
}
