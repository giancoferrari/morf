import { useEffect, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { DropArea, QueueList, ToolHeader } from "@/components/files"
import { OptionsForm } from "@/components/options"
import { Button } from "@/components/ui/button"
import { catalog, engineStatus, targetsFor, type JobSettings, type Kind, type Target } from "@/lib/engine"
import { getPrefs, loadJSON, saveJSON, usePrefs } from "@/lib/prefs"
import { addPaths, clearQueue, removeItem, runQueue, stopQueue, useQueue } from "@/lib/queue"
import { cn, formatBytes } from "@/lib/utils"

const GROUP_LABEL: Record<Target["group"], string> = { video: "Video", audio: "Audio", image: "Image" }

export function ConvertScreen({ dragging }: { dragging: boolean }) {
  const { items, running } = useQueue("convert")
  const prefs = usePrefs()
  const [all, setAll] = useState<Target[]>([])
  const [hw, setHw] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(() => loadJSON("convert.lastTarget", null))
  const [advanced, setAdvanced] = useState(false)
  const [settingsById, setSettingsById] = useState<Record<string, JobSettings>>(() =>
    getPrefs().rememberFormatSettings ? loadJSON("convert.settings", {}) : {},
  )

  useEffect(() => {
    void catalog().then(setAll)
    void engineStatus().then((s) => setHw(s.hwEncoders.length > 0)).catch(() => {})
  }, [])

  const usable = items.filter((i) => !i.file.problem)
  const kinds = useMemo(() => [...new Set(usable.map((i) => i.file.kind))] as Kind[], [usable])
  const targets = useMemo(() => targetsFor(all, kinds), [all, kinds])
  const target = targets.find((t) => t.id === targetId) ?? null
  const settings = target ? (settingsById[target.id] ?? {}) : {}

  // Pick a sensible default when the selection changes and the current choice no longer fits.
  useEffect(() => {
    if (!targets.length || (targetId && targets.some((t) => t.id === targetId))) return
    const first = kinds.includes("video") ? "mp4-h264" : kinds.includes("audio") ? "mp3" : kinds.includes("image") ? "jpeg" : targets[0].id
    setTargetId(targets.find((t) => t.id === first)?.id ?? targets[0].id)
  }, [targets, targetId, kinds])

  const patchSettings = (patch: Partial<JobSettings>) => {
    if (!target) return
    setSettingsById((prev) => {
      const next = { ...prev, [target.id]: { ...prev[target.id], ...patch } }
      if (getPrefs().rememberFormatSettings) saveJSON("convert.settings", next)
      return next
    })
  }

  const choose = (id: string) => {
    setTargetId(id)
    saveJSON("convert.lastTarget", id)
  }

  const start = () => {
    if (!target) return
    void runQueue("convert", () => ({
      target: target.id,
      settings: { ...settings, hardware: prefs.hardware && settings.hardware !== false },
    }))
  }

  const total = items.reduce((n, i) => n + i.file.size, 0)
  const done = items.filter((i) => i.state === "done").length
  const groups = (["video", "audio", "image"] as const)
    .map((g) => ({ g, list: targets.filter((t) => t.group === g) }))
    .filter((x) => x.list.length)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader
        title="Convert"
        meta={
          items.length ? (
            <div className="label flex gap-6 text-ink-3">
              <span>
                <span className="text-ink">{items.length}</span> {items.length === 1 ? "file" : "files"}
              </span>
              <span>{formatBytes(total)}</span>
              {done ? (
                <span>
                  <span className="text-ink">{done}</span> done
                </span>
              ) : null}
            </div>
          ) : null
        }
      >
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">
          Audio, video and images into any other format. The new file appears next to the original; nothing is
          overwritten.
        </p>
      </ToolHeader>

      {items.length === 0 ? (
        <DropArea shellHint dragging={dragging} kinds={["Audio", "Video", "Images"]} onPaths={(p) => void addPaths("convert", p)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          {/* Files */}
          <section className="scroll-quiet col-span-7 min-h-0 overflow-y-auto pl-5">
            <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 text-ink-4">
              <span>Files</span>
              {!running ? (
                <button className="focus-ring transition-colors hover:text-ink" onClick={() => clearQueue("convert")}>
                  Clear
                </button>
              ) : null}
            </div>
            <QueueList items={items} busy={running} onRemove={(id) => removeItem("convert", id)} />
            <p className={cn("label py-5 text-ink-4 transition-colors", dragging && "text-ink")}>
              {dragging ? "Drop to add" : "Drop more files anywhere"}
            </p>
          </section>

          {/* Formats and settings */}
          <section className="col-span-5 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">Into</div>
              {targets.length === 0 ? (
                <p className="py-6 text-[13px] text-ink-3">
                  {kinds.length > 1
                    ? "These files can't become one common format. Convert images separately from audio and video."
                    : "Nothing to convert these files into yet."}
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  {groups.map(({ g, list }) => (
                    <div key={g} className="flex flex-col">
                      {groups.length > 1 ? <span className="label mb-1 text-ink-4">{GROUP_LABEL[g]}</span> : null}
                      <div className="flex flex-wrap gap-x-4 gap-y-0">
                        {list.map((t) => (
                          <button
                            key={t.id}
                            onClick={() => choose(t.id)}
                            disabled={running}
                            className={cn(
                              "focus-ring flex items-start gap-1 text-[30px]/[1.15] font-[540] tracking-[-0.035em] transition-colors duration-150",
                              t.id === target?.id ? "text-ink" : "text-ghost hover:text-ink-4",
                            )}
                          >
                            {t.label}
                            {t.detail ? (
                              <sup className="mt-1.5 font-serif text-[13px] font-normal tracking-normal">{t.detail}</sup>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {target ? (
                <div className="mt-8">
                  <button
                    onClick={() => setAdvanced((a) => !a)}
                    className="label focus-ring flex items-center gap-1.5 py-2 text-ink-3 transition-colors hover:text-ink"
                    aria-expanded={advanced}
                  >
                    <ChevronRight size={12} strokeWidth={2} className={cn("transition-transform duration-200", advanced && "rotate-90")} />
                    Advanced · {target.label}
                    {target.detail ? ` ${target.detail}` : ""}
                  </button>
                  {advanced ? (
                    <div className="anim-fade">
                      <OptionsForm target={target} settings={settings} onChange={patchSettings} hardwareAvailable={hw && prefs.hardware} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Action bar */}
            <div className="flex items-center justify-between gap-4 border-t border-hair px-5 py-4">
              <span className="label text-ink-4">
                {prefs.outputMode === "folder" && prefs.outputFolder ? "To your output folder" : "Next to originals"}
                {prefs.trashOriginals ? " · originals to Trash" : ""}
              </span>
              {running ? (
                <Button size="xl" variant="outline" onClick={() => void stopQueue("convert")}>
                  Stop
                </Button>
              ) : (
                <Button size="xl" variant="solid" disabled={!target || usable.length === 0} onClick={start}>
                  Convert {usable.length > 1 ? `${usable.length} files` : ""} to {target?.label ?? "…"}
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
