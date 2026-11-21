import { useRef, useState } from "react"

/**
 * Drag to reorder with the pointer. (HTML drag-and-drop doesn't work inside the app's window,
 * which takes drags for dropping files.) Items carry `data-reorder={index}`; a press that moves
 * a few pixels becomes a drag, so a plain click still clicks.
 */
export function useReorder(onMove: (from: number, to: number) => void) {
  const [drag, setDragState] = useState<{ from: number; over: number } | null>(null)
  const dragRef = useRef(drag)
  const setDrag = (d: typeof drag) => {
    dragRef.current = d
    setDragState(d)
  }
  const start = useRef<{ x: number; y: number; index: number; moved: boolean } | null>(null)
  /** The click that follows a drag's release shouldn't count as a click. */
  const justDragged = useRef(false)

  const indexAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-reorder]")
    return el ? Number(el.dataset.reorder) : null
  }

  const bind = (index: number) => ({
    "data-reorder": index,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,[data-no-drag]")) return
      start.current = { x: e.clientX, y: e.clientY, index, moved: false }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current
      if (!s) return
      if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return
      s.moved = true
      const over = indexAt(e.clientX, e.clientY)
      setDrag({ from: s.index, over: over ?? s.index })
    },
    onPointerUp: () => {
      const s = start.current
      start.current = null
      const d = dragRef.current
      setDrag(null)
      if (s?.moved) {
        justDragged.current = true
        setTimeout(() => (justDragged.current = false), 0)
      }
      if (s?.moved && d && d.from !== d.over) onMove(d.from, d.over)
    },
    onPointerCancel: () => {
      start.current = null
      setDrag(null)
    },
    /** Swallow the click that ends a drag. */
    onClickCapture: (e: React.MouseEvent) => {
      if (justDragged.current) e.stopPropagation()
    },
  })

  return { drag, bind }
}

export function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}
