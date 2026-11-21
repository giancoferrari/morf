import { ArrowUpRight, X } from "lucide-react"
import { pickFiles, reveal } from "@/lib/engine"
import type { QueueItem } from "@/lib/queue"
import { basename, cn, formatBytes, formatDuration } from "@/lib/utils"

/** The big empty state every file tool opens with. */
export function DropArea({
  dragging,
  kinds,
  onPaths,
  title = "Drop files",
}: {
  dragging: boolean
  kinds: string[]
  onPaths: (paths: string[]) => void
  title?: string
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden border-t border-hair px-5 pt-6 pb-6 transition-colors duration-300",
        dragging && "bg-paper-2",
      )}
    >
      <div className="label flex justify-between text-ink-4">
        <span>{kinds.join(" · ")}</span>
        <span>Nothing leaves this computer</span>
      </div>
      <div className="flex flex-col gap-5">
        <p
          className={cn(
            "display text-[clamp(64px,11vw,180px)] transition-colors duration-300",
            dragging ? "text-ink" : "text-ghost",
          )}
        >
          {dragging ? "Let go" : title}
        </p>
        <div className="flex items-center gap-5 pl-1">
          <button
            onClick={async () => {
              const p = await pickFiles()
              if (p.length) onPaths(p)
            }}
            className="focus-ring group flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.01em] text-ink"
          >
            <span className="underline decoration-hair-strong underline-offset-4 transition-colors group-hover:decoration-ink">
              or choose files
            </span>
            <ArrowUpRight size={15} strokeWidth={1.5} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </button>
          <span className="label text-ink-4">or right-click any file → Morf</span>
        </div>
      </div>
    </div>
  )
}

const STATE_LABEL: Record<QueueItem["state"], string> = {
  idle: "Ready",
  queued: "Waiting",
  running: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
}

/** The batch: one hairline row per file, numbered like an index. */
export function QueueList({
  items,
  onRemove,
  showSaving = false,
  busy,
}: {
  items: QueueItem[]
  onRemove: (id: string) => void
  showSaving?: boolean
  busy: boolean
}) {
  return (
    <ol className="flex flex-col">
      {items.map((it, i) => {
        const saved = it.outSize && it.file.size ? 1 - it.outSize / it.file.size : null
        return (
          <li
            key={it.id}
            className="group anim-rise relative grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-hair py-3.5"
            style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}
          >
            <span className="label text-ink-4 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] font-medium tracking-[-0.01em]" title={it.file.path}>
                {it.file.name}
              </span>
              <span className="label flex flex-wrap gap-x-3 text-ink-4">
                <span>{it.file.kind}</span>
                <span>{formatBytes(it.file.size)}</span>
                {it.file.duration ? <span>{formatDuration(it.file.duration)}</span> : null}
                {it.file.width ? (
                  <span>
                    {it.file.width}×{it.file.height}
                  </span>
                ) : null}
                {it.file.problem ? <span className="text-signal normal-case tracking-normal">{it.file.problem}</span> : null}
                {it.error ? <span className="text-signal normal-case tracking-normal">{it.error}</span> : null}
                {it.fallback ? <span className="normal-case tracking-normal">Saved to Downloads (folder is read-only)</span> : null}
              </span>
            </div>
            <div className="flex items-center gap-4">
              {it.state === "done" && it.outSize ? (
                <span className="flex items-baseline gap-2 tabular-nums">
                  <span className="label text-ink-3">{formatBytes(it.outSize)}</span>
                  {showSaving && saved !== null ? (
                    <span className={cn("text-[15px] font-medium tracking-[-0.02em]", saved > 0 ? "text-ink" : "text-signal")}>
                      {saved > 0 ? `−${Math.round(saved * 100)}%` : `+${Math.round(-saved * 100)}%`}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span
                  className={cn(
                    "label",
                    it.state === "failed" ? "text-signal" : it.state === "running" ? "text-ink" : "text-ink-4",
                  )}
                >
                  {it.state === "running" && it.progress > 0 ? `${Math.round(it.progress * 100)}%` : STATE_LABEL[it.state]}
                </span>
              )}
              {it.state === "done" && it.output ? (
                <button
                  onClick={() => reveal(it.output!)}
                  className="label focus-ring text-ink-3 transition-colors hover:text-ink"
                  title={it.output}
                >
                  Show {basename(it.output).length > 24 ? "" : basename(it.output)}
                </button>
              ) : null}
              <button
                onClick={() => onRemove(it.id)}
                disabled={busy && (it.state === "running" || it.state === "queued")}
                className="focus-ring grid size-6 place-items-center text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink disabled:hidden"
                aria-label={`Remove ${it.file.name}`}
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </div>
            {/* Progress is the row's bottom hairline filling with ink. */}
            {it.state === "running" ? (
              <span
                className="absolute bottom-[-1px] left-0 h-px bg-ink transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(2, it.progress * 100)}%` }}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/** Large tool title with mono columns beside it, like a studio "Works" page. */
export function ToolHeader({ title, children, meta }: { title: string; children?: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="grid shrink-0 grid-cols-12 gap-x-5 px-5 pt-7 pb-7">
      <h1 className="display anim-rise col-span-12 text-[clamp(64px,8.5vw,136px)] lg:col-span-6">{title}</h1>
      <div className="col-span-12 mt-6 flex flex-wrap gap-x-12 gap-y-4 self-end pb-2 lg:col-span-6 lg:mt-0">
        {children}
        {meta ? <div className="ml-auto self-end">{meta}</div> : null}
      </div>
    </div>
  )
}

/** A mono label with a column of choices under or beside it. */
export function FilterColumn<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string; count?: number; disabled?: boolean }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-6">
      <span className="label text-ink">{label}</span>
      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "label focus-ring flex w-fit items-start gap-1 text-left transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40",
              value === o.value ? "text-ink" : "text-ink-4",
            )}
          >
            {o.label}
            {o.count !== undefined ? <span className="text-[8.5px] leading-[10px]">{o.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
