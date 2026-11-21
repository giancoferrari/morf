import { useState } from "react"
import { DropArea, QueueList, ToolHeader } from "@/components/files"
import { Range, Select } from "@/components/options"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented } from "@/components/ui/settings-panel"
import type { JobSettings } from "@/lib/engine"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { addPaths, clearQueue, removeItem, runQueue, stopQueue, useQueue } from "@/lib/queue"
import { cn, formatBytes } from "@/lib/utils"

type Mode = NonNullable<JobSettings["resizeMode"]>

const PRESETS: { label: string; hint: string; w: number; h: number; mode: Mode }[] = [
  { label: "Square", hint: "Instagram post", w: 1080, h: 1080, mode: "fill" },
  { label: "Portrait", hint: "Instagram 4:5", w: 1080, h: 1350, mode: "fill" },
  { label: "Story", hint: "9:16", w: 1080, h: 1920, mode: "fill" },
  { label: "Full HD", hint: "16:9", w: 1920, h: 1080, mode: "fill" },
  { label: "4K", hint: "16:9", w: 3840, h: 2160, mode: "fill" },
  { label: "Web", hint: "Longest side", w: 2000, h: 2000, mode: "fit" },
  { label: "Thumbnail", hint: "400 px", w: 400, h: 400, mode: "fit" },
  { label: "Avatar", hint: "512 px", w: 512, h: 512, mode: "fill" },
]

const MODES: { id: Mode; name: string; note: string }[] = [
  { id: "fit", name: "Fit", note: "Shrinks to fit inside the box. Keeps the whole picture and its shape." },
  { id: "fill", name: "Fill", note: "Fills the box exactly, cropping what spills over from the centre." },
  { id: "pad", name: "Pad", note: "Fits the whole picture and adds a border to make the exact size." },
  { id: "percent", name: "Scale", note: "A percentage of the original size." },
]

interface Saved {
  mode: Mode
  width: number | null
  height: number | null
  percent: number
  background: NonNullable<JobSettings["background"]>
  format: NonNullable<JobSettings["format"]>
  quality: number
}

const DEFAULTS: Saved = { mode: "fit", width: 2000, height: 2000, percent: 50, background: "transparent", format: "keep", quality: 88 }

function NumberBox({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label text-ink-4">{label}</span>
      <input
        type="number"
        min={1}
        max={20000}
        value={value ?? ""}
        placeholder="Auto"
        onChange={(e) => onChange(e.target.value ? Math.max(1, Math.min(20000, Number(e.target.value))) : null)}
        className="chatcn-focus h-12 w-36 rounded-lg bg-paper-2 px-3 text-[26px] font-[540] tracking-[-0.03em] text-ink tabular-nums outline-none placeholder:text-ink-4"
      />
    </label>
  )
}

export function ResizeScreen({ dragging }: { dragging: boolean }) {
  const { items, running } = useQueue("resize")
  const [s, setS] = useState<Saved>(() => ({ ...DEFAULTS, ...loadJSON<Partial<Saved>>("resize.settings", {}) }))
  const patch = (p: Partial<Saved>) =>
    setS((prev) => {
      const next = { ...prev, ...p }
      saveJSON("resize.settings", next)
      return next
    })
  const usable = items.filter((i) => !i.file.problem && i.file.kind === "image")
  const mode = MODES.find((m) => m.id === s.mode)!

  const start = () =>
    void runQueue("resize", () => ({
      settings: {
        resizeMode: s.mode,
        width: s.width,
        height: s.height,
        percent: s.percent,
        background: s.background,
        format: s.format,
        imageQuality: s.quality,
      },
    }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader
        title="Resize"
        meta={
          items.length ? (
            <div className="label flex gap-6 text-ink-3">
              <span>
                <span className="text-ink">{items.length}</span> {items.length === 1 ? "image" : "images"}
              </span>
              <span>{formatBytes(items.reduce((n, i) => n + i.file.size, 0))}</span>
            </div>
          ) : null
        }
      >
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">
          Batch resize, crop or pad photos to an exact size. New copies, named with their size.
        </p>
      </ToolHeader>

      {items.length === 0 ? (
        <DropArea dragging={dragging} kinds={["JPEG", "PNG", "WebP", "HEIC", "TIFF"]} onPaths={(p) => void addPaths("resize", p)} title="Drop images" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          <section className="scroll-quiet col-span-7 min-h-0 overflow-y-auto pl-5">
            <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 text-ink-4">
              <span>Images</span>
              {!running ? (
                <button className="focus-ring transition-colors hover:text-ink" onClick={() => clearQueue("resize")}>
                  Clear
                </button>
              ) : null}
            </div>
            <QueueList items={items} busy={running} onRemove={(id) => removeItem("resize", id)} />
            <p className={cn("label py-5 text-ink-4 transition-colors", dragging && "text-ink")}>{dragging ? "Drop to add" : "Drop more images anywhere"}</p>
          </section>

          <section className="col-span-5 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">How</div>
              <div className="flex flex-wrap gap-x-4">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => patch({ mode: m.id })}
                    className={cn("focus-ring text-[30px]/[1.15] font-[540] tracking-[-0.035em] transition-colors", m.id === s.mode ? "text-ink" : "text-ghost hover:text-ink-4")}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              <p key={mode.id} className="anim-fade mt-2 text-[13px]/[19px] text-ink-3">
                {mode.note}
              </p>

              <div className="mt-6">
                {s.mode === "percent" ? (
                  <Range aria-label="Scale" value={s.percent} min={5} max={200} step={5} onChange={(v) => patch({ percent: v })} format={(v) => `${v}%`} />
                ) : (
                  <div className="flex items-end gap-3">
                    <NumberBox label="Width" value={s.width} onChange={(v) => patch({ width: v })} />
                    <span className="pb-3 text-[22px] text-ink-4">×</span>
                    <NumberBox label="Height" value={s.height} onChange={(v) => patch({ height: v })} />
                    <span className="label pb-4 text-ink-4">px</span>
                  </div>
                )}
              </div>

              {s.mode !== "percent" ? (
                <div className="mt-5 flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => patch({ width: p.w, height: p.h, mode: p.mode })}
                      className={cn(
                        "chatcn-focus inline-flex h-8 items-center justify-center rounded-full px-3.5 text-[13px] leading-none font-medium transition-colors",
                        s.width === p.w && s.height === p.h && s.mode === p.mode ? "bg-ink text-paper" : "bg-paper-2 text-ink-2 hover:bg-paper-3",
                      )}
                    >
                      {/* Baseline-aligned inside, centred as a whole in the pill. */}
                      <span className="flex items-baseline gap-1.5">
                        {p.label}
                        <span className="text-[11px] opacity-60">{p.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="mt-8 divide-y divide-hair border-t border-hair">
                {s.mode === "pad" ? (
                  <SettingsRow label="Border colour" description="Transparent turns white in JPEGs.">
                    <SettingsSegmented
                      size="xs"
                      value={s.background}
                      onValueChange={(v) => patch({ background: v as Saved["background"] })}
                      options={[
                        { value: "transparent", label: "None" },
                        { value: "white", label: "White" },
                        { value: "black", label: "Black" },
                      ]}
                    />
                  </SettingsRow>
                ) : null}
                <SettingsRow label="Save as">
                  <Select
                    aria-label="Save as"
                    value={s.format}
                    onChange={(v) => patch({ format: v as Saved["format"] })}
                    options={[
                      { value: "keep", label: "Same type" },
                      { value: "jpeg", label: "JPEG" },
                      { value: "png", label: "PNG" },
                      { value: "webp", label: "WebP" },
                    ]}
                  />
                </SettingsRow>
                {s.format !== "png" ? (
                  <SettingsRow label="Quality">
                    <Range aria-label="Quality" value={s.quality} min={40} max={100} onChange={(v) => patch({ quality: v })} />
                  </SettingsRow>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-hair px-5 py-4">
              <span className="label text-ink-4">Copies · originals kept</span>
              {running ? (
                <Button size="xl" variant="outline" onClick={() => void stopQueue("resize")}>
                  Stop
                </Button>
              ) : (
                <Button size="xl" variant="solid" disabled={!usable.length || (s.mode !== "percent" && !s.width && !s.height)} onClick={start}>
                  Resize {usable.length > 1 ? `${usable.length} images` : ""}
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
