import { useEffect, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { Dialog } from "@base-ui/react/dialog"
import { DropArea, QueueList, ToolHeader } from "@/components/files"
import { Select } from "@/components/options"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { fileUrl, type JobSettings, type Kind } from "@/lib/engine"
import { loadJSON, saveJSON, usePrefs } from "@/lib/prefs"
import { addPaths, clearQueue, removeItem, runQueue, stopQueue, useQueue, type QueueItem } from "@/lib/queue"
import { cn, formatBytes } from "@/lib/utils"

type Level = "light" | "balanced" | "strong" | "size"

const LEVELS: { id: Level; name: string; note: string; typical: string }[] = [
  { id: "light", name: "Light", note: "Hard to tell apart from the original.", typical: "30–50% smaller" },
  { id: "balanced", name: "Balanced", note: "The best trade for most files.", typical: "60–80% smaller" },
  { id: "strong", name: "Strong", note: "Smallest; softer on a close look.", typical: "80–95% smaller" },
  { id: "size", name: "Fit to size", note: "Each file ends up under the size you set.", typical: "Exact limit" },
]

const SIZE_PRESETS = [
  { mb: 8, label: "8 MB", hint: "Discord" },
  { mb: 16, label: "16 MB", hint: "WhatsApp" },
  { mb: 25, label: "25 MB", hint: "Email" },
  { mb: 50, label: "50 MB", hint: "" },
]

interface Saved {
  level: Level
  targetMB: number
  videoCodec: NonNullable<JobSettings["videoCodec"]>
  maxDimension: string
  imageFormat: NonNullable<JobSettings["imageFormat"]>
  audioFormat: NonNullable<JobSettings["audioFormat"]>
  stripMetadata: boolean
}

const DEFAULT_SAVED: Saved = {
  level: "balanced",
  targetMB: 25,
  videoCodec: "h265",
  maxDimension: "source",
  imageFormat: "keep",
  audioFormat: "keep",
  stripMetadata: true,
}

export function CompressScreen({ dragging }: { dragging: boolean }) {
  const { items, running } = useQueue("compress")
  const prefs = usePrefs()
  const [s, setS] = useState<Saved>(() => ({ ...DEFAULT_SAVED, ...loadJSON<Partial<Saved>>("compress.settings", {}) }))
  const [advanced, setAdvanced] = useState(false)
  const [compare, setCompare] = useState<QueueItem | null>(null)
  const patch = (p: Partial<Saved>) =>
    setS((prev) => {
      const next = { ...prev, ...p }
      saveJSON("compress.settings", next)
      return next
    })

  const usable = items.filter((i) => !i.file.problem)
  const kinds = useMemo(() => new Set(usable.map((i) => i.file.kind)), [usable]) as Set<Kind>
  const total = items.reduce((n, i) => n + i.file.size, 0)
  const doneItems = items.filter((i) => i.state === "done" && i.outSize)
  const before = doneItems.reduce((n, i) => n + i.file.size, 0)
  const after = doneItems.reduce((n, i) => n + (i.outSize ?? 0), 0)
  const finished = !running && doneItems.length > 0

  const start = () =>
    void runQueue("compress", () => ({
      settings: {
        level: s.level === "size" ? "balanced" : s.level,
        targetMB: s.level === "size" ? s.targetMB : null,
        videoCodec: s.videoCodec,
        maxDimension: s.maxDimension,
        imageFormat: s.imageFormat,
        audioFormat: s.audioFormat,
        stripMetadata: s.stripMetadata,
        hardware: prefs.hardware,
      },
    }))

  const level = LEVELS.find((l) => l.id === s.level)!

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader
        title="Compress"
        meta={
          items.length ? (
            <div className="label flex gap-6 text-ink-3">
              <span>
                <span className="text-ink">{items.length}</span> {items.length === 1 ? "file" : "files"}
              </span>
              <span>{formatBytes(total)}</span>
            </div>
          ) : null
        }
      >
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">
          Videos, audio, photos and PDFs, made a fraction of the size. Saved as a copy beside the original.
        </p>
      </ToolHeader>

      {items.length === 0 ? (
        <DropArea dragging={dragging} kinds={["Video", "Audio", "Images", "PDF"]} onPaths={(p) => void addPaths("compress", p)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          <section className="scroll-quiet col-span-7 min-h-0 overflow-y-auto pl-5">
            {finished ? (
              <div className="anim-rise flex items-end justify-between gap-6 border-b border-hair py-6">
                <div>
                  <p className="label text-ink-4">Saved</p>
                  <p className="display text-[88px]">−{Math.max(0, Math.round((1 - after / before) * 100))}%</p>
                </div>
                <p className="label pb-3 text-right text-ink-3">
                  {formatBytes(before)} → <span className="text-ink">{formatBytes(after)}</span>
                  <br />
                  {formatBytes(Math.max(0, before - after))} freed
                </p>
              </div>
            ) : null}
            <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 text-ink-4">
              <span>Files</span>
              {!running ? (
                <button className="focus-ring transition-colors hover:text-ink" onClick={() => clearQueue("compress")}>
                  Clear
                </button>
              ) : null}
            </div>
            <QueueList items={items} busy={running} showSaving onRemove={(id) => removeItem("compress", id)} />
            {doneItems.some((i) => i.file.kind === "image") ? (
              <div className="flex flex-wrap gap-2 py-4">
                {doneItems
                  .filter((i) => i.file.kind === "image")
                  .slice(0, 6)
                  .map((i) => (
                    <Button key={i.id} size="xs" variant="subtle" onClick={() => setCompare(i)}>
                      Compare {i.file.name.length > 18 ? `${i.file.name.slice(0, 16)}…` : i.file.name}
                    </Button>
                  ))}
              </div>
            ) : null}
            <p className={cn("label py-5 text-ink-4 transition-colors", dragging && "text-ink")}>
              {dragging ? "Drop to add" : "Drop more files anywhere"}
            </p>
          </section>

          <section className="col-span-5 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">How much</div>
              <div className="flex flex-col">
                {LEVELS.map((l) => (
                  <button
                    key={l.id}
                    disabled={running}
                    onClick={() => patch({ level: l.id })}
                    className={cn(
                      "focus-ring group flex items-baseline justify-between gap-4 text-left transition-colors duration-150",
                      l.id === s.level ? "text-ink" : "text-ghost hover:text-ink-4",
                    )}
                  >
                    <span className="text-[30px]/[1.2] font-[540] tracking-[-0.035em]">{l.name}</span>
                    <span className={cn("label shrink-0", l.id === s.level ? "text-ink-3" : "text-transparent group-hover:text-ink-4")}>
                      {l.typical}
                    </span>
                  </button>
                ))}
              </div>
              <p key={level.id} className="anim-fade mt-3 text-[13px]/[19px] text-ink-3">
                {level.note}
              </p>

              {s.level === "size" ? (
                <div className="anim-fade mt-5 flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {SIZE_PRESETS.map((p) => (
                      <button
                        key={p.mb}
                        onClick={() => patch({ targetMB: p.mb })}
                        className={cn(
                          "chatcn-focus flex h-8 items-baseline gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors",
                          s.targetMB === p.mb ? "bg-ink text-paper" : "bg-paper-2 text-ink-2 hover:bg-paper-3",
                        )}
                      >
                        {p.label}
                        {p.hint ? <span className="text-[11px] opacity-60">{p.hint}</span> : null}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-3 text-[13px] text-ink-3">
                    Or under
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={s.targetMB}
                      onChange={(e) => patch({ targetMB: Math.max(0.5, Number(e.target.value) || 1) })}
                      className="chatcn-focus h-8 w-20 rounded-md bg-paper-2 px-2.5 text-[13px] font-medium text-ink tabular-nums outline-none"
                    />
                    MB per file
                  </label>
                </div>
              ) : null}

              <div className="mt-8">
                <button
                  onClick={() => setAdvanced((a) => !a)}
                  className="label focus-ring flex items-center gap-1.5 py-2 text-ink-3 transition-colors hover:text-ink"
                  aria-expanded={advanced}
                >
                  <ChevronRight size={12} strokeWidth={2} className={cn("transition-transform duration-200", advanced && "rotate-90")} />
                  Advanced
                </button>
                {advanced ? (
                  <div className="anim-fade divide-y divide-hair border-t border-hair">
                    {kinds.has("video") || kinds.size === 0 ? (
                      <>
                        <SettingsRow label="Video codec" description="H.265 is half the size of H.264 at the same quality. AV1 is smaller still but slow.">
                          <SettingsSegmented
                            size="xs"
                            value={s.videoCodec}
                            onValueChange={(v) => patch({ videoCodec: v as Saved["videoCodec"] })}
                            options={[
                              { value: "h264", label: "H.264" },
                              { value: "h265", label: "H.265" },
                              { value: "av1", label: "AV1" },
                            ]}
                          />
                        </SettingsRow>
                        <SettingsRow label="Largest resolution" description="Never upscales.">
                          <Select
                            aria-label="Largest resolution"
                            value={s.maxDimension}
                            onChange={(v) => patch({ maxDimension: v })}
                            options={[
                              { value: "source", label: "Same as source" },
                              { value: "1080", label: "1080p" },
                              { value: "720", label: "720p" },
                              { value: "480", label: "480p" },
                            ]}
                          />
                        </SettingsRow>
                      </>
                    ) : null}
                    {kinds.has("image") || kinds.size === 0 ? (
                      <SettingsRow label="Image format" description="WebP and AVIF are far smaller; Keep leaves the type alone.">
                        <Select
                          aria-label="Image format"
                          value={s.imageFormat}
                          onChange={(v) => patch({ imageFormat: v as Saved["imageFormat"] })}
                          options={[
                            { value: "keep", label: "Keep format" },
                            { value: "jpeg", label: "JPEG" },
                            { value: "webp", label: "WebP" },
                            { value: "avif", label: "AVIF" },
                          ]}
                        />
                      </SettingsRow>
                    ) : null}
                    {kinds.has("audio") || kinds.size === 0 ? (
                      <SettingsRow label="Audio format" description="Opus is the smallest at the same quality.">
                        <Select
                          aria-label="Audio format"
                          value={s.audioFormat}
                          onChange={(v) => patch({ audioFormat: v as Saved["audioFormat"] })}
                          options={[
                            { value: "keep", label: "Keep format" },
                            { value: "opus", label: "Opus" },
                            { value: "aac", label: "AAC" },
                            { value: "mp3", label: "MP3" },
                          ]}
                        />
                      </SettingsRow>
                    ) : null}
                    <SettingsRow label="Remove metadata" description="Camera, location and editing details. Smaller and more private.">
                      <SettingsSwitch checked={s.stripMetadata} onCheckedChange={(v) => patch({ stripMetadata: v })} />
                    </SettingsRow>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-hair px-5 py-4">
              <span className="label text-ink-4">Copies · originals kept</span>
              {running ? (
                <Button size="xl" variant="outline" onClick={() => void stopQueue("compress")}>
                  Stop
                </Button>
              ) : (
                <Button size="xl" variant="solid" disabled={usable.length === 0} onClick={start}>
                  Compress {usable.length > 1 ? `${usable.length} files` : ""}
                </Button>
              )}
            </div>
          </section>
        </div>
      )}

      <CompareDialog item={compare} onClose={() => setCompare(null)} />
    </div>
  )
}

/** Original on the left of the handle, compressed on the right. */
function CompareDialog({ item, onClose }: { item: QueueItem | null; onClose: () => void }) {
  const [urls, setUrls] = useState<{ a: string | null; b: string | null }>({ a: null, b: null })
  const [split, setSplit] = useState(50)
  useEffect(() => {
    if (!item?.output) return
    setSplit(50)
    void Promise.all([fileUrl(item.file.path), fileUrl(item.output)]).then(([a, b]) => setUrls({ a, b }))
  }, [item])

  return (
    <Dialog.Root open={!!item} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-paper/80 backdrop-blur-sm transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-6 z-50 flex flex-col gap-3 outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
          <div className="label flex justify-between text-ink-3">
            <Dialog.Title className="text-ink">{item?.file.name}</Dialog.Title>
            <span>
              Original {item ? formatBytes(item.file.size) : ""} · Compressed {item?.outSize ? formatBytes(item.outSize) : ""}
            </span>
            <Dialog.Close className="focus-ring text-ink transition-opacity hover:opacity-60">Close</Dialog.Close>
          </div>
          <div
            className="relative min-h-0 flex-1 cursor-ew-resize overflow-hidden bg-paper-2"
            onPointerMove={(e) => {
              if (e.buttons !== 1 && e.pointerType === "mouse") return
              const r = e.currentTarget.getBoundingClientRect()
              setSplit(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
            }}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setSplit(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
            }}
          >
            {urls.b ? <img src={urls.b} alt="Compressed" className="absolute inset-0 size-full object-contain" draggable={false} /> : null}
            {urls.a ? (
              <img
                src={urls.a}
                alt="Original"
                className="absolute inset-0 size-full object-contain"
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                draggable={false}
              />
            ) : null}
            <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${split}%` }}>
              <span className="label absolute top-3 right-2 whitespace-nowrap text-ink">Original</span>
              <span className="label absolute top-3 left-2 whitespace-nowrap text-ink">Compressed</span>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
