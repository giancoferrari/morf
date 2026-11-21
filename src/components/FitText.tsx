import { useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Display type that shrinks to fit its column on one line: as large as `max`, never smaller than
 * `min`. Past `min` it wraps (breaking anywhere, since file names have few spaces) instead of
 * running into the next column.
 */
export function FitText({
  children,
  max,
  min = 22,
  className,
  title,
}: {
  children: string
  max: number
  min?: number
  className?: string
  title?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState(max)
  const [wrap, setWrap] = useState(false)

  useLayoutEffect(() => {
    const el = box.current
    const p = probe.current
    if (!el || !p) return
    const fit = () => {
      const avail = el.clientWidth
      // The probe is set at `max` and never wraps, so its width scales linearly with font size.
      const natural = p.scrollWidth
      if (!avail || !natural) return
      const next = Math.floor(Math.min(max, (max * avail) / natural) * 2) / 2
      setSize(Math.max(min, next))
      setWrap(next < min)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    void document.fonts?.ready.then(fit)
    return () => ro.disconnect()
  }, [children, max, min])

  return (
    <div ref={box} className={cn("relative min-w-0", className)} title={title}>
      <span
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap"
        style={{ fontSize: max }}
      >
        {children}
      </span>
      <span className={cn("block", wrap ? "[overflow-wrap:anywhere]" : "whitespace-nowrap")} style={{ fontSize: size }}>
        {/* Prefer breaking after _ . - so file names wrap at their joins, not mid-word. */}
        {wrap ? children.replace(/([_.\-])/g, "$1​") : children}
      </span>
    </div>
  )
}
