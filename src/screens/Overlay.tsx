import { useEffect, useRef, useState } from "react"
import { Mark } from "@/components/Logo"
import { dictation, type DictationEvent } from "@/lib/engine"
import { cn } from "@/lib/utils"

/** A short, soft tone. Rising on start, falling on stop. */
function chime(up: boolean) {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = "sine"
    const t = ctx.currentTime
    o.frequency.setValueAtTime(up ? 660 : 880, t)
    o.frequency.exponentialRampToValueAtTime(up ? 880 : 520, t + 0.12)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + 0.2)
    setTimeout(() => void ctx.close(), 400)
  } catch {
    /* no audio device */
  }
}

/**
 * The pill that floats above the taskbar while dictating. Lives in its own transparent,
 * click-through window, so it never steals focus from the app the words are going to.
 */
export function Overlay() {
  const [state, setState] = useState<DictationEvent["state"]>("idle")
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<number[]>(() => Array(16).fill(0))
  const sounds = useRef(true)
  const prev = useRef<DictationEvent["state"]>("idle")

  useEffect(() => {
    document.documentElement.classList.add("overlay-root")
    void dictation.settings().then((s) => (sounds.current = s.sounds))
    let off: (() => void) | undefined
    void dictation
      .onEvent((e) => {
        if (e.level !== undefined) {
          setLevels((l) => [...l.slice(1), e.level!])
        }
        if (e.state !== prev.current) {
          if (sounds.current && e.state === "recording" && prev.current !== "recording") chime(true)
          if (sounds.current && prev.current === "recording" && e.state !== "recording") chime(false)
          if (e.state === "recording") void dictation.settings().then((s) => (sounds.current = s.sounds))
          prev.current = e.state
          setState(e.state)
          setError(e.state === "error" ? (e.error ?? "Something went wrong") : null)
          if (e.state !== "recording") setLevels(Array(16).fill(0))
        }
      })
      .then((u) => (off = u))
    return () => off?.()
  }, [])

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <div
        className={cn(
          "flex h-11 items-center gap-3 rounded-full px-4 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]",
          "bg-[oklch(0.17_0.004_90/0.94)] text-[oklch(0.97_0.004_90)] backdrop-blur",
        )}
      >
        <Mark className={cn("h-3.5", state === "recording" && "overlay-breathe")} />
        {state === "error" ? (
          <span className="max-w-[160px] truncate text-[12px] font-medium">{error}</span>
        ) : state === "transcribing" ? (
          <span className="flex items-center gap-2 text-[12px] font-medium">
            <span className="overlay-dots flex gap-1">
              <i />
              <i />
              <i />
            </span>
            Writing
          </span>
        ) : (
          <span className="flex h-6 items-center gap-[3px]">
            {levels.map((l, i) => (
              <span key={i} className="w-[3px] rounded-full bg-current transition-[height] duration-75" style={{ height: `${Math.max(3, l * 22)}px`, opacity: 0.5 + l / 2 }} />
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
