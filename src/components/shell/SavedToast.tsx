import { useEffect, useRef, useState } from "react"
import { Check, Copy, FolderOpen, X } from "lucide-react"
import { reveal } from "@/lib/engine"
import { dismissSaved, useSavedNotice } from "@/lib/saved"
import { basename, cn, formatBytes } from "@/lib/utils"

/** Folder part of a path, for the dimmer half of each line. */
function dirOf(path: string) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"))
  return i > 0 ? path.slice(0, i + 1) : ""
}

/**
 * The card that appears when a tool has written files: where they are, and the two things people
 * do next (open the folder, copy the path). Stays while hovered; otherwise leaves after 12 s.
 */
export function SavedToast() {
  const notice = useSavedNotice()
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<number>(0)

  useEffect(() => {
    setCopied(false)
    setLeaving(false)
  }, [notice?.id])

  useEffect(() => {
    if (!notice || hover) return
    timer.current = window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(dismissSaved, 220)
    }, 12_000)
    return () => window.clearTimeout(timer.current)
  }, [notice, hover])

  if (!notice) return null
  const { files } = notice
  const single = files.length === 1
  const shown = files.slice(0, 4)

  return (
    <div
      key={notice.id}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "fixed right-5 bottom-5 z-[60] w-[min(440px,calc(100vw-40px))] rounded-2xl bg-card p-5 shadow-float",
        leaving ? "opacity-0 transition-opacity duration-200" : "anim-pop",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-5 place-items-center rounded-full bg-ink text-paper">
            <Check size={12} strokeWidth={2.5} />
          </span>
          <span className="text-[15px] font-medium tracking-[-0.01em]">
            {single ? "Saved" : `${files.length} files saved`}
          </span>
          <span className="label text-ink-4">{notice.tool}</span>
        </div>
        <button
          onClick={dismissSaved}
          className="focus-ring -mt-1 -mr-1 grid size-7 place-items-center rounded-lg text-ink-4 transition-colors hover:bg-paper-2 hover:text-ink"
          aria-label="Dismiss"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {shown.map((f) => (
          <li key={f.path} className="flex items-baseline justify-between gap-3">
            <button
              onClick={() => void reveal(f.path)}
              title={f.path}
              className="focus-ring min-w-0 truncate text-left font-mono text-[11.5px]/[17px] transition-colors hover:text-ink"
            >
              <span className="text-ink-4">{dirOf(f.path)}</span>
              <span className="text-ink">{basename(f.path)}</span>
            </button>
            {f.size ? <span className="label shrink-0 text-ink-4">{formatBytes(f.size)}</span> : null}
          </li>
        ))}
        {files.length > shown.length ? <li className="label text-ink-4">and {files.length - shown.length} more</li> : null}
      </ul>

      {notice.detail ? <p className="mt-2 text-[12.5px] text-ink-3">{notice.detail}</p> : null}

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => void reveal(files[0].path)}
          className="chatcn-focus flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-85"
        >
          <FolderOpen size={14} strokeWidth={1.75} />
          Show in folder
        </button>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(files.map((f) => f.path).join("\n"))
            setCopied(true)
          }}
          className="chatcn-focus flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-paper-3"
        >
          {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
          {copied ? "Copied" : single ? "Copy path" : "Copy paths"}
        </button>
      </div>
    </div>
  )
}
