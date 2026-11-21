import { useMemo, useState } from "react"
import { ArrowLeftRight } from "lucide-react"
import { diffArrays, diffChars, diffLines, diffWordsWithSpace, type Change } from "diff"
import { ToolHeader } from "@/components/files"
import { SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { files as fileApi, pickFiles } from "@/lib/engine"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { basename, cn } from "@/lib/utils"

type Mode = "words" | "lines" | "chars"

function Pane({
  label,
  value,
  onChange,
  name,
  onOpen,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  name: string | null
  onOpen: () => void
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="label flex items-center justify-between py-3 text-ink-4">
        <span>
          {label}
          {name ? <span className="ml-2 normal-case tracking-normal text-ink-3">{name}</span> : null}
        </span>
        <button onClick={onOpen} className="focus-ring transition-colors hover:text-ink">
          Open file
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="Paste text here"
        className="scroll-quiet min-h-0 flex-1 resize-none rounded-lg bg-paper-2 p-4 font-mono text-[12.5px]/[20px] text-ink outline-none placeholder:text-ink-4 focus:bg-paper-3/60"
      />
    </div>
  )
}

export function CompareScreen() {
  const [a, setA] = useState<string>(() => loadJSON("compare.a", ""))
  const [b, setB] = useState<string>(() => loadJSON("compare.b", ""))
  const [names, setNames] = useState<[string | null, string | null]>([null, null])
  const [mode, setMode] = useState<Mode>("words")
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [ignoreSpace, setIgnoreSpace] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (side: 0 | 1, v: string) => {
    if (side === 0) {
      setA(v)
      saveJSON("compare.a", v.length < 200_000 ? v : "")
    } else {
      setB(v)
      saveJSON("compare.b", v.length < 200_000 ? v : "")
    }
  }

  const open = async (side: 0 | 1) => {
    const [p] = await pickFiles()
    if (!p) return
    try {
      update(side, await fileApi.readText(p))
      setNames((n) => (side === 0 ? [basename(p), n[1]] : [n[0], basename(p)]))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const changes: Change[] = useMemo(() => {
    if (!a && !b) return []
    const norm = (s: string) => (ignoreSpace && mode !== "lines" ? s.replace(/[ \t]+/g, " ") : s)
    if (mode === "lines") {
      if (!ignoreCase) return diffLines(a, b, { ignoreWhitespace: ignoreSpace })
      // Lines have no ignoreCase option: diff the arrays of lines with a case-blind comparator.
      const fold = (s: string) => (ignoreSpace ? s.replace(/\s+/g, " ").trim() : s).toLowerCase()
      const NL = String.fromCharCode(10)
      return diffArrays(a.split(NL), b.split(NL), { comparator: (l, r) => fold(l) === fold(r) }).map((c) => ({
        ...c,
        value: c.value.join(NL) + NL,
      })) as unknown as Change[]
    }
    if (mode === "chars") return diffChars(norm(a), norm(b), { ignoreCase })
    return diffWordsWithSpace(norm(a), norm(b), { ignoreCase })
  }, [a, b, mode, ignoreCase, ignoreSpace])

  const stats = useMemo(() => {
    const unit = (s: string) => (mode === "lines" ? s.split("\n").filter(Boolean).length : mode === "chars" ? s.length : (s.match(/\S+/g) ?? []).length)
    let added = 0
    let removed = 0
    let same = 0
    for (const c of changes) {
      if (c.added) added += unit(c.value)
      else if (c.removed) removed += unit(c.value)
      else same += unit(c.value)
    }
    const total = same * 2 + added + removed
    return { added, removed, similarity: total ? Math.round(((same * 2) / total) * 100) : 100 }
  }, [changes, mode])

  const unitWord = mode === "lines" ? "lines" : mode === "chars" ? "characters" : "words"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader
        title="Compare"
        meta={
          a || b ? (
            <div className="label flex gap-6 text-ink-3">
              <span className="text-ok">+{stats.added}</span>
              <span className="text-signal">−{stats.removed}</span>
              <span>
                <span className="text-ink">{stats.similarity}%</span> alike
              </span>
            </div>
          ) : null
        }
      >
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">See exactly what changed between two versions of a text. Paste them or open files.</p>
      </ToolHeader>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-t border-hair">
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 px-5 pb-4">
          <Pane label="Before" value={a} onChange={(v) => update(0, v)} name={names[0]} onOpen={() => void open(0)} />
          <button
            onClick={() => {
              const [x, y] = [a, b]
              update(0, y)
              update(1, x)
              setNames(([n0, n1]) => [n1, n0])
            }}
            className="focus-ring mt-10 grid size-8 place-items-center self-center rounded-full text-ink-4 transition-colors hover:bg-paper-2 hover:text-ink"
            aria-label="Swap"
            title="Swap"
          >
            <ArrowLeftRight size={15} strokeWidth={1.6} />
          </button>
          <Pane label="After" value={b} onChange={(v) => update(1, v)} name={names[1]} onOpen={() => void open(1)} />
        </div>

        <div className="flex min-h-0 flex-col border-t border-hair">
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3">
            <span className="label text-ink-4">Differences</span>
            <div className="flex flex-wrap items-center gap-5">
              <label className="label flex items-center gap-2 text-ink-3">
                Ignore case <SettingsSwitch aria-label="Ignore case" checked={ignoreCase} onCheckedChange={setIgnoreCase} />
              </label>
              <label className="label flex items-center gap-2 text-ink-3">
                Ignore spacing <SettingsSwitch aria-label="Ignore spacing" checked={ignoreSpace} onCheckedChange={setIgnoreSpace} />
              </label>
              <SettingsSegmented
                size="xs"
                aria-label="Compare by"
                value={mode}
                onValueChange={(v) => setMode(v as Mode)}
                options={[
                  { value: "words", label: "Words" },
                  { value: "lines", label: "Lines" },
                  { value: "chars", label: "Characters" },
                ]}
              />
            </div>
          </div>
          {error ? <p className="px-5 text-[13px] text-signal">{error}</p> : null}
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-8">
            {!a && !b ? (
              <p className="display pt-6 text-[clamp(40px,5vw,72px)] text-ghost">Paste two versions.</p>
            ) : stats.added === 0 && stats.removed === 0 ? (
              <p className="display pt-6 text-[clamp(40px,5vw,72px)]">Identical.</p>
            ) : (
              <div className={cn("max-w-[80ch] whitespace-pre-wrap break-words text-[15px]/[26px] text-ink select-text", mode !== "words" && "font-mono text-[13px]/[22px]")}>
                {changes.map((c, i) =>
                  c.added ? (
                    <ins key={i} className="rounded-[3px] bg-[color-mix(in_oklch,var(--ok)_18%,transparent)] text-ink no-underline decoration-ok">
                      {c.value}
                    </ins>
                  ) : c.removed ? (
                    <del key={i} className="rounded-[3px] bg-[color-mix(in_oklch,var(--signal)_14%,transparent)] text-ink-3 decoration-signal/70">
                      {c.value}
                    </del>
                  ) : (
                    <span key={i}>{c.value}</span>
                  ),
                )}
              </div>
            )}
            {a || b ? (
              <p className="label mt-6 text-ink-4">
                {stats.added} {unitWord} added · {stats.removed} removed
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
