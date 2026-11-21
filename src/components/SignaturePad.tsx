import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export const INKS = { black: "#141414", blue: "#1f3d8f" } as const
export type Ink = keyof typeof INKS

/** Crops a canvas to its inked pixels (plus a little air) and returns a PNG data URL. */
function trimmed(src: HTMLCanvasElement): string | null {
  const ctx = src.getContext("2d")!
  const { width: w, height: h } = src
  const data = ctx.getImageData(0, 0, w, h).data
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  const pad = 6
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(w - 1, x1 + pad)
  y1 = Math.min(h - 1, y1 + pad)
  const out = document.createElement("canvas")
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL("image/png")
}

/** The pad is always paper-white, in dark mode too: a signature is ink on paper. */

/** Draw with the mouse or a pen. Reports the trimmed signature each time a stroke ends. */
export function DrawPad({ ink, onChange, clearSignal }: { ink: Ink; onChange: (png: string | null) => void; clearSignal: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number; mx: number; my: number } | null>(null)
  const [empty, setEmpty] = useState(true)
  const SCALE = 3

  useEffect(() => {
    const c = ref.current!
    const r = c.getBoundingClientRect()
    c.width = Math.round(r.width * SCALE)
    c.height = Math.round(r.height * SCALE)
  }, [])

  useEffect(() => {
    const c = ref.current!
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height)
    setEmpty(true)
    onChange(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal])

  // Recolour what's there when the ink changes.
  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext("2d")!
    ctx.globalCompositeOperation = "source-in"
    ctx.fillStyle = INKS[ink]
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.globalCompositeOperation = "source-over"
    if (!empty) onChange(trimmed(c))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ink])

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) * SCALE, y: (e.clientY - r.top) * SCALE }
  }

  return (
    <div className="relative">
      <canvas
        ref={ref}
        className="block h-40 w-full cursor-crosshair touch-none rounded-xl bg-[#fbfaf7] ring-1 ring-hair"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = point(e)
          last.current = { ...p, mx: p.x, my: p.y }
          const ctx = ref.current!.getContext("2d")!
          ctx.fillStyle = INKS[ink]
          ctx.beginPath()
          ctx.arc(p.x, p.y, 2.2 * SCALE * 0.5, 0, Math.PI * 2)
          ctx.fill()
          setEmpty(false)
        }}
        onPointerMove={(e) => {
          const l = last.current
          if (!l) return
          const p = point(e)
          const ctx = ref.current!.getContext("2d")!
          // Smooth with midpoints; pen pressure thickens the line a little.
          const mx = (l.x + p.x) / 2
          const my = (l.y + p.y) / 2
          const pressure = e.pointerType === "pen" && e.pressure > 0 ? 0.6 + e.pressure : 1
          ctx.strokeStyle = INKS[ink]
          ctx.lineWidth = 2.2 * SCALE * pressure
          ctx.lineCap = "round"
          ctx.lineJoin = "round"
          ctx.beginPath()
          ctx.moveTo(l.mx, l.my)
          ctx.quadraticCurveTo(l.x, l.y, mx, my)
          ctx.stroke()
          last.current = { x: p.x, y: p.y, mx, my }
        }}
        onPointerUp={() => {
          last.current = null
          onChange(trimmed(ref.current!))
        }}
      />
      {empty ? <span className="label pointer-events-none absolute inset-0 grid place-items-center text-[#a3a29c]">Sign here</span> : null}
      <span className="pointer-events-none absolute inset-x-6 bottom-9 h-px bg-black/15" />
    </div>
  )
}

/** Type a name; it's set in Instrument Serif italic, like a signature. */
export function TypePad({ ink, onChange }: { ink: Ink; onChange: (png: string | null) => void }) {
  const [name, setName] = useState("")
  const box = useRef<HTMLInputElement>(null)
  const [size, setSize] = useState(56)

  // Long names shrink to fit the pad instead of scrolling out of sight.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const m = document.createElement("canvas").getContext("2d")!
      m.font = "italic 400 56px 'Instrument Serif'"
      const w = m.measureText(name || "Your name").width
      setSize(Math.max(22, Math.min(56, Math.floor((56 * (el.clientWidth - 4)) / Math.max(1, w)))))
    }
    fit()
    void document.fonts.load("italic 400 56px 'Instrument Serif'").then(fit)
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!name.trim()) return onChange(null)
      const font = "italic 400 140px 'Instrument Serif'"
      await document.fonts.load(font)
      if (cancelled) return
      const c = document.createElement("canvas")
      const m = c.getContext("2d")!
      m.font = font
      const w = Math.ceil(m.measureText(name).width) + 60
      c.width = w
      c.height = 220
      const ctx = c.getContext("2d")!
      ctx.font = font
      ctx.fillStyle = INKS[ink]
      ctx.textBaseline = "alphabetic"
      ctx.fillText(name, 30, 150)
      onChange(trimmed(c))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ink])

  return (
    <div className="relative flex h-40 items-center rounded-xl bg-[#fbfaf7] px-6 ring-1 ring-hair">
      <input
        ref={box}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        spellCheck={false}
        className={cn("w-full bg-transparent font-serif italic leading-none outline-none placeholder:text-[#d4d3ce]")}
        style={{ color: INKS[ink], fontSize: size }}
        aria-label="Type your signature"
      />
      <span className="pointer-events-none absolute inset-x-6 bottom-9 h-px bg-black/15" />
    </div>
  )
}
