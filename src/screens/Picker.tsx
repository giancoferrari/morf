import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

/** Pixels either side of the centre in the loupe (11 × 11), and how big each one is drawn. */
const R = 5
const CELL = 12
const LOUPE = (R * 2 + 1) * CELL

const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()

/**
 * One picker window per monitor, covering it with a still of the screen. A loupe follows the
 * cursor; a click picks the pixel under it, arrow keys nudge by one pixel, Enter picks, Esc cancels.
 */
export function Picker({ index }: { index: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const loupe = useRef<HTMLCanvasElement>(null)
  const pixels = useRef<{ w: number; h: number; data: Uint8ClampedArray } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [nudge, setNudge] = useState({ x: 0, y: 0 })
  const [hex, setHex] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.style.background = "#000"
    document.body.style.background = "#000"
    let cancelled = false
    void (async () => {
      const buf = await invoke<ArrayBuffer>("picker_shot", { index })
      if (cancelled) return
      const view = new DataView(buf)
      const w = view.getUint32(0, true)
      const h = view.getUint32(4, true)
      const data = new Uint8ClampedArray(buf, 8, w * h * 4)
      pixels.current = { w, h, data }
      const c = canvas.current!
      c.width = w
      c.height = h
      c.getContext("2d")!.putImageData(new ImageData(data, w, h), 0, 0)
      // Wait a frame so the still is on screen before the window appears.
      requestAnimationFrame(() => void invoke("picker_ready", { index }))
    })()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void invoke("picker_done", { hex: null })
    }
    window.addEventListener("keydown", onKey)
    return () => {
      cancelled = true
      window.removeEventListener("keydown", onKey)
    }
  }, [index])

  /** The still's pixel under a point in the window (the still is physical pixels, CSS is not). */
  const sample = (x: number, y: number) => {
    const p = pixels.current
    if (!p) return null
    const px = Math.min(p.w - 1, Math.max(0, Math.floor((x / window.innerWidth) * p.w)))
    const py = Math.min(p.h - 1, Math.max(0, Math.floor((y / window.innerHeight) * p.h)))
    return { px, py }
  }

  // Redraw the loupe and the hex whenever the point moves.
  useEffect(() => {
    const p = pixels.current
    const l = loupe.current
    if (!p || !l || !pos) return
    const at = sample(pos.x, pos.y)
    if (!at) return
    const cx = Math.min(p.w - 1, Math.max(0, at.px + nudge.x))
    const cy = Math.min(p.h - 1, Math.max(0, at.py + nudge.y))
    const ctx = l.getContext("2d")!
    ctx.clearRect(0, 0, LOUPE, LOUPE)
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const sx = cx + dx
        const sy = cy + dy
        if (sx < 0 || sy < 0 || sx >= p.w || sy >= p.h) {
          ctx.fillStyle = "#000"
        } else {
          const i = (sy * p.w + sx) * 4
          ctx.fillStyle = `rgb(${p.data[i]},${p.data[i + 1]},${p.data[i + 2]})`
        }
        ctx.fillRect((dx + R) * CELL, (dy + R) * CELL, CELL, CELL)
      }
    }
    // Faint grid, then the centre pixel outlined in both black and white so it shows on anything.
    ctx.strokeStyle = "rgba(0,0,0,0.12)"
    ctx.lineWidth = 1
    for (let i = 1; i < R * 2 + 1; i++) {
      ctx.beginPath()
      ctx.moveTo(i * CELL + 0.5, 0)
      ctx.lineTo(i * CELL + 0.5, LOUPE)
      ctx.moveTo(0, i * CELL + 0.5)
      ctx.lineTo(LOUPE, i * CELL + 0.5)
      ctx.stroke()
    }
    ctx.strokeStyle = "#000"
    ctx.strokeRect(R * CELL - 0.5, R * CELL - 0.5, CELL + 1, CELL + 1)
    ctx.strokeStyle = "#fff"
    ctx.strokeRect(R * CELL + 0.5, R * CELL + 0.5, CELL - 1, CELL - 1)
    const i = (cy * p.w + cx) * 4
    setHex(toHex(p.data[i], p.data[i + 1], p.data[i + 2]))
  }, [pos, nudge])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (d) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        setNudge((n) => ({ x: n.x + d[0] * step, y: n.y + d[1] * step }))
      } else if (e.key === "Enter" && hex) {
        void invoke("picker_done", { hex })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hex])

  // Keep the loupe beside the cursor, flipped away from the screen's edges.
  const gap = 22
  const boxW = LOUPE + 2
  const boxH = LOUPE + 38
  const left = pos ? (pos.x + gap + boxW > window.innerWidth ? pos.x - gap - boxW : pos.x + gap) : 0
  const top = pos ? (pos.y + gap + boxH > window.innerHeight ? pos.y - gap - boxH : pos.y + gap) : 0

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      onPointerMove={(e) => {
        setPos({ x: e.clientX, y: e.clientY })
        setNudge({ x: 0, y: 0 })
      }}
      onPointerDown={(e) => {
        if (e.button === 2) return void invoke("picker_done", { hex: null })
        if (hex) void invoke("picker_done", { hex })
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} />

      <div className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 rounded-full bg-[#111]/85 px-4 py-2 font-mono text-[10.5px] tracking-[0.08em] text-white/80 uppercase backdrop-blur">
        Click to pick · Arrows to nudge · Esc to cancel
      </div>

      <div
        className="pointer-events-none absolute flex flex-col overflow-hidden rounded-xl bg-[#111] shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_40px_-12px_rgba(0,0,0,0.6)]"
        style={{ left, top, width: boxW, visibility: pos ? "visible" : "hidden" }}
      >
        <canvas ref={loupe} width={LOUPE} height={LOUPE} className="m-px block" style={{ width: LOUPE, height: LOUPE }} />
        <div className="flex h-9 items-center gap-2 px-3">
          <span className="size-3.5 rounded-full ring-1 ring-white/25" style={{ background: hex ?? "transparent" }} />
          <span className="font-mono text-[12px] tracking-[0.04em] text-white tabular-nums">{hex}</span>
        </div>
      </div>
    </div>
  )
}
