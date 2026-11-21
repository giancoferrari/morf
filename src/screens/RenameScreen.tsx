import { useEffect, useMemo, useState } from "react"
import { ArrowRight, X } from "lucide-react"
import { DropArea, ToolHeader } from "@/components/files"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { files as fileApi, inspect, onWindowDrop, pickFiles, type FileInfo } from "@/lib/engine"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { announceSaved } from "@/lib/saved"
import { cn } from "@/lib/utils"

type CaseMode = "keep" | "lower" | "upper" | "title" | "kebab" | "snake"

interface Rules {
  pattern: string
  find: string
  replace: string
  regex: boolean
  matchCase: boolean
  caseMode: CaseMode
  start: number
  digits: number
  keepExt: boolean
}

const DEFAULT_RULES: Rules = { pattern: "{name}", find: "", replace: "", regex: false, matchCase: false, caseMode: "keep", start: 1, digits: 2, keepExt: true }

const splitName = (name: string) => {
  const i = name.lastIndexOf(".")
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: "" }
}

function applyCase(s: string, mode: CaseMode) {
  switch (mode) {
    case "lower":
      return s.toLowerCase()
    case "upper":
      return s.toUpperCase()
    case "title":
      return s.toLowerCase().replace(/(^|[\s_\-.])(\p{L})/gu, (_, a, b: string) => a + b.toUpperCase())
    case "kebab":
      return s.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-")
    case "snake":
      return s.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_")
    default:
      return s
  }
}

const today = () => new Date().toISOString().slice(0, 10)
const BAD = /[<>:"/\\|?*\x00-\x1f]/

function newName(file: FileInfo, index: number, r: Rules): { name: string; error?: string } {
  const { stem, ext } = splitName(file.name)
  let base = stem
  if (r.find) {
    try {
      const flags = r.matchCase ? "g" : "gi"
      const re = r.regex ? new RegExp(r.find, flags) : new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
      base = base.replace(re, r.replace)
    } catch {
      return { name: file.name, error: "The pattern isn't valid." }
    }
  }
  const n = String(r.start + index).padStart(r.digits, "0")
  let out = (r.pattern || "{name}").replaceAll("{name}", base).replaceAll("{n}", n).replaceAll("{date}", today())
  out = applyCase(out, r.caseMode).trim()
  const name = out + (r.keepExt ? ext : "")
  if (!out) return { name, error: "Empty name" }
  if (BAD.test(name)) return { name, error: "Has a character files can't use" }
  return { name }
}

const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1)

export function RenameScreen() {
  const [list, setList] = useState<FileInfo[]>([])
  const [rules, setRules] = useState<Rules>(() => ({ ...DEFAULT_RULES, ...loadJSON<Partial<Rules>>("rename.rules", {}) }))
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<{ from: string; to: string }[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const patch = (p: Partial<Rules>) =>
    setRules((prev) => {
      const next = { ...prev, ...p }
      saveJSON("rename.rules", next)
      return next
    })

  const add = async (paths: string[]) => {
    const known = new Set(list.map((f) => f.path))
    const infos = await inspect(paths.filter((p) => !known.has(p)))
    setList((l) => [...l, ...infos.filter((i) => i.size > 0 || !i.problem?.includes("folder"))])
    setMessage(null)
  }

  // This screen takes drops itself (any kind of file is fine to rename).
  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => void add(p) }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  const preview = useMemo(() => {
    const rows = list.map((f, i) => ({ file: f, ...newName(f, i, rules) }))
    const seen = new Map<string, number>()
    for (const r of rows) {
      const key = (dirOf(r.file.path) + r.name).toLowerCase()
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    return rows.map((r) => ({ ...r, error: r.error ?? ((seen.get((dirOf(r.file.path) + r.name).toLowerCase()) ?? 0) > 1 ? "Two files would get this name" : undefined) }))
  }, [list, rules])

  const changes = preview.filter((r) => r.name !== r.file.name)
  const blocked = preview.some((r) => r.error)

  const apply = async () => {
    setBusy(true)
    const pairs = changes.map((r) => ({ from: r.file.path, to: dirOf(r.file.path) + r.name }))
    const results = await fileApi.rename(pairs)
    const ok = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    setUndo(ok.map((r) => ({ from: r.to, to: r.from })))
    // Keep the list, now pointing at the new names, so a second pass can follow.
    const moved = new Map(ok.map((r) => [r.from, r.to]))
    setList((l) => l.map((f) => (moved.has(f.path) ? { ...f, path: moved.get(f.path)!, name: moved.get(f.path)!.split(/[\\/]/).pop()!, ext: "" } : f)))
    setMessage(failed.length ? `${failed.length} couldn't be renamed: ${failed[0].error}` : null)
    if (ok.length) announceSaved("Rename", ok.map((r) => ({ path: r.to })), `${ok.length} renamed`)
    setBusy(false)
  }

  const revert = async () => {
    if (!undo) return
    setBusy(true)
    const results = await fileApi.rename(undo)
    const back = new Map(results.filter((r) => r.ok).map((r) => [r.from, r.to]))
    setList((l) => l.map((f) => (back.has(f.path) ? { ...f, path: back.get(f.path)!, name: back.get(f.path)!.split(/[\\/]/).pop()! } : f)))
    setUndo(null)
    setBusy(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="Rename">
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Rename hundreds of files at once with a pattern. See every new name before anything changes.</p>
      </ToolHeader>

      {list.length === 0 ? (
        <DropArea dragging={dragging} kinds={["Any files"]} onPaths={(p) => void add(p)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          <section className="scroll-quiet col-span-7 min-h-0 overflow-y-auto pl-5">
            <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 text-ink-4">
              <span>
                {changes.length} of {list.length} change
              </span>
              <span className="flex gap-4">
                <button className="focus-ring transition-colors hover:text-ink" onClick={async () => add(await pickFiles())}>
                  Add
                </button>
                <button className="focus-ring transition-colors hover:text-ink" onClick={() => setList([])}>
                  Clear
                </button>
              </span>
            </div>
            <ol>
              {preview.map((r, i) => (
                <li key={r.file.path} className="group grid grid-cols-[2.5rem_minmax(0,1fr)_1.25rem_minmax(0,1fr)_1.5rem] items-center gap-x-3 border-b border-hair py-3">
                  <span className="label text-ink-4 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  <span className="truncate text-[14px] text-ink-3" title={r.file.path}>
                    {r.file.name}
                  </span>
                  <ArrowRight size={13} className="text-ink-4" />
                  <span className={cn("truncate text-[14px] font-medium", r.error ? "text-signal" : r.name === r.file.name ? "text-ink-4" : "text-ink")} title={r.error ?? r.name}>
                    {r.name}
                    {r.error ? <span className="label ml-2 normal-case tracking-normal">{r.error}</span> : null}
                  </span>
                  <button
                    onClick={() => setList((l) => l.filter((f) => f.path !== r.file.path))}
                    className="focus-ring grid size-6 place-items-center text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                    aria-label={`Remove ${r.file.name}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ol>
            <p className={cn("label py-5 text-ink-4", dragging && "text-ink")}>{dragging ? "Drop to add" : "Drop more files anywhere"}</p>
          </section>

          <section className="col-span-5 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">New name</div>
              <input
                value={rules.pattern}
                onChange={(e) => patch({ pattern: e.target.value })}
                spellCheck={false}
                className="chatcn-focus h-14 w-full rounded-lg bg-paper-2 px-4 font-mono text-[20px] text-ink outline-none"
              />
              <div className="mt-3 flex items-start gap-3">
                <span className="label flex h-7 w-12 shrink-0 items-center text-ink-4">Insert</span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ["{name}", "Current name"],
                    ["{n}", "Number"],
                    ["{date}", "Today"],
                  ].map(([t, l]) => (
                    <button
                      key={t}
                      onClick={() => patch({ pattern: rules.pattern + (rules.pattern.endsWith(" ") || !rules.pattern ? "" : " ") + t })}
                      className="chatcn-focus inline-flex h-7 items-center rounded-full bg-paper-2 px-3 text-[12px] leading-none text-ink-2 transition-colors hover:bg-paper-3"
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-mono">{t}</span>
                        <span className="opacity-60">{l}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex items-start gap-3">
                <span className="label flex h-7 w-12 shrink-0 items-center text-ink-4">Start</span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ["{name}", "Original name"],
                    ["Photo {n}", "Photo 01, 02…"],
                    ["{date} {name}", "Date and name"],
                  ].map(([p, l]) => (
                    <button
                      key={l}
                      onClick={() => patch({ pattern: p })}
                      className={cn(
                        "chatcn-focus inline-flex h-7 items-center rounded-full px-3 text-[12px] leading-none ring-1 ring-hair-strong transition-colors hover:bg-paper-2 hover:text-ink",
                        rules.pattern === p ? "bg-paper-2 text-ink" : "text-ink-3",
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 divide-y divide-hair border-t border-hair">
                <SettingsRow label="Find" stacked>
                  <div className="flex w-full gap-2">
                    <input value={rules.find} onChange={(e) => patch({ find: e.target.value })} placeholder="Text to find" className="chatcn-focus h-9 min-w-0 flex-1 rounded-md bg-paper-2 px-3 text-[13px] outline-none placeholder:text-ink-4" />
                    <input value={rules.replace} onChange={(e) => patch({ replace: e.target.value })} placeholder="Replace with" className="chatcn-focus h-9 min-w-0 flex-1 rounded-md bg-paper-2 px-3 text-[13px] outline-none placeholder:text-ink-4" />
                  </div>
                </SettingsRow>
                <SettingsRow label="Match case">
                  <SettingsSwitch checked={rules.matchCase} onCheckedChange={(v) => patch({ matchCase: v })} />
                </SettingsRow>
                <SettingsRow label="Regular expression" description="For advanced patterns, like \d+ for numbers.">
                  <SettingsSwitch checked={rules.regex} onCheckedChange={(v) => patch({ regex: v })} />
                </SettingsRow>
                <SettingsRow label="Case">
                  <SettingsSegmented
                    size="xs"
                    value={rules.caseMode}
                    onValueChange={(v) => patch({ caseMode: v as CaseMode })}
                    options={[
                      { value: "keep", label: "Keep" },
                      { value: "lower", label: "lower" },
                      { value: "upper", label: "UPPER" },
                      { value: "title", label: "Title" },
                      { value: "kebab", label: "kebab" },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow label="Numbers start at" description={`{n} counts from here with ${rules.digits} digits.`}>
                  <div className="flex gap-2">
                    <input type="number" value={rules.start} onChange={(e) => patch({ start: Number(e.target.value) || 0 })} className="chatcn-focus h-8 w-16 rounded-md bg-paper-2 px-2 text-[13px] tabular-nums outline-none" />
                    <SettingsSegmented
                      size="xs"
                      value={String(rules.digits)}
                      onValueChange={(v) => patch({ digits: Number(v) })}
                      options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "01" },
                        { value: "3", label: "001" },
                      ]}
                    />
                  </div>
                </SettingsRow>
                <SettingsRow label="Keep the extension" description="Leaves .jpg, .pdf and so on as they are.">
                  <SettingsSwitch checked={rules.keepExt} onCheckedChange={(v) => patch({ keepExt: v })} />
                </SettingsRow>
              </div>
              {message ? <p className="mt-4 text-[13px] text-signal">{message}</p> : null}
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-hair px-5 py-4">
              {undo?.length ? (
                <Button size="md" variant="ghost" disabled={busy} onClick={() => void revert()}>
                  Undo last rename
                </Button>
              ) : (
                <span className="label text-ink-4">Nothing is replaced</span>
              )}
              <Button size="xl" variant="solid" disabled={busy || !changes.length || blocked} onClick={() => void apply()}>
                Rename {changes.length || ""} {changes.length === 1 ? "file" : "files"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
