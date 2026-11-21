import { useEffect, useMemo, useRef, useState } from "react"
import { SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { applyFix, checkGrammar, type Issue } from "@/lib/grammar"
import { loadJSON, saveJSON, usePrefs } from "@/lib/prefs"
import { changeCase, computeStats, keywordDensity, readingLevel, type CaseMode } from "@/lib/textstats"
import { cn, formatDuration } from "@/lib/utils"

const SAMPLE = ""

const nf = new Intl.NumberFormat()

/**
 * Count: a writing surface with live measures beside it. Words are the headline; everything else
 * is a quiet table under them. Grammar marks are drawn on a layer under the text area, so typing
 * stays native (undo, IME, spellcheck menus) while issues still show in place.
 */
export function CountScreen() {
  const { dialect } = usePrefs()
  const [text, setText] = useState<string>(() => loadJSON("count.draft", SAMPLE))
  const [goal, setGoal] = useState<number>(() => loadJSON("count.goal", 0))
  const [gram, setGram] = useState<1 | 2 | 3>(1)
  const [checking, setChecking] = useState<boolean>(() => loadJSON("count.grammar", true))
  const [issues, setIssues] = useState<Issue[]>([])
  const [grammarState, setGrammarState] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [activeIssue, setActiveIssue] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  const stats = useMemo(() => computeStats(text), [text])
  const keywords = useMemo(() => keywordDensity(text, gram, 8), [text, gram])
  const level = readingLevel(stats.readingEase)

  // Autosave the draft.
  useEffect(() => {
    const t = setTimeout(() => saveJSON("count.draft", text), 300)
    return () => clearTimeout(t)
  }, [text])

  // Grammar, debounced. Stale results are dropped if the text changed meanwhile.
  useEffect(() => {
    saveJSON("count.grammar", checking)
    if (!checking) {
      setIssues([])
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        if (grammarState === "idle") setGrammarState("loading")
        const found = await checkGrammar(text, dialect)
        if (!cancelled) {
          setIssues(found)
          setGrammarState("ready")
        }
      } catch (e) {
        console.error(e)
        if (!cancelled) setGrammarState("error")
      }
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, checking, dialect])

  /** Replace the whole text but keep it undoable (execCommand goes through the undo stack). */
  const replaceAll = (next: string) => {
    const el = area.current
    if (!el) return setText(next)
    el.focus()
    el.select()
    if (!document.execCommand("insertText", false, next)) setText(next)
  }

  const applyCase = (mode: CaseMode) => {
    const el = area.current
    if (el && el.selectionStart !== el.selectionEnd) {
      const { selectionStart: a, selectionEnd: b } = el
      el.focus()
      document.execCommand("insertText", false, changeCase(text.slice(a, b), mode))
      el.setSelectionRange(a, b)
    } else replaceAll(changeCase(text, mode))
  }

  const fix = async (issue: Issue, index: number) => {
    const next = await applyFix(text, issue, index, dialect)
    replaceAll(next)
  }

  const onCaret = () => {
    const el = area.current
    if (!el) return
    const at = el.selectionStart
    const hit = issues.find((i) => at >= i.start && at <= i.end)
    setActiveIssue(hit?.id ?? null)
  }

  useEffect(() => {
    if (activeIssue) document.getElementById(`issue-${activeIssue}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [activeIssue])

  const goalPct = goal > 0 ? Math.min(1, stats.words / goal) : 0

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_400px]">
      {/* Editor */}
      <section className="flex min-h-0 flex-col">
        <div className="flex items-end justify-between gap-6 px-5 pt-7 pb-5">
          <h1 className="display anim-rise text-[clamp(56px,6vw,96px)]">Count</h1>
          {/* Two groups that wrap as wholes, so a narrow window never strands one word on a line. */}
          <div className="label flex flex-wrap items-center justify-end gap-x-8 gap-y-2 pb-2 text-ink-4">
            <span className="flex items-center gap-x-5 whitespace-nowrap">
            <span className="text-ink">Case</span>
            {(
              [
                ["upper", "UPPER"],
                ["lower", "lower"],
                ["title", "Title"],
                ["sentence", "Sentence"],
                ["toggle", "Toggle"],
              ] as [CaseMode, string][]
            ).map(([m, l]) => (
              <button key={m} onClick={() => applyCase(m)} className="focus-ring normal-case tracking-normal transition-colors hover:text-ink">
                {l}
              </button>
            ))}
            </span>
            <span className="flex items-center gap-x-5 whitespace-nowrap">
            <button
              className="focus-ring transition-colors hover:text-ink"
              onClick={async () => {
                await navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="focus-ring transition-colors hover:text-ink" onClick={() => replaceAll("")}>
              Clear
            </button>
            </span>
          </div>
        </div>

        <div className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto border-t border-hair">
          <div className="grid min-h-full px-5 pt-6 pb-24 [&>*]:col-start-1 [&>*]:row-start-1">
            {/* Mark layer: same box and type as the text area, text invisible, marks visible. */}
            <div aria-hidden="true" className="editor-type pointer-events-none whitespace-pre-wrap break-words text-transparent">
              <Marks text={text} issues={checking ? issues : []} active={activeIssue} />
              {"\n​"}
            </div>
            <textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onSelect={onCaret}
              onClick={onCaret}
              spellCheck={false}
              placeholder="Start typing, or paste your text here."
              className="editor-type resize-none overflow-hidden bg-transparent text-ink outline-none placeholder:text-ghost"
            />
          </div>
        </div>

        {/* Goal */}
        <div className="flex items-center gap-5 border-t border-hair px-5 py-3">
          <label className="label flex items-center gap-2 text-ink-4">
            Goal
            <input
              type="number"
              min={0}
              step={50}
              value={goal || ""}
              placeholder="—"
              onChange={(e) => {
                const v = Math.max(0, Number(e.target.value) || 0)
                setGoal(v)
                saveJSON("count.goal", v)
              }}
              className="chatcn-focus h-6 w-20 rounded-md bg-paper-2 px-2 font-mono text-[11px] text-ink tabular-nums outline-none placeholder:text-ink-4"
            />
            words
          </label>
          <div className="relative h-px flex-1 bg-hair">
            <div className="absolute inset-y-0 left-0 bg-ink transition-[width] duration-500 ease-out-quint" style={{ width: `${goalPct * 100}%` }} />
          </div>
          <span className="label text-ink-4 tabular-nums">
            {goal ? (goalPct >= 1 ? "Reached" : `${Math.round(goalPct * 100)}%`) : "Draft saved"}
          </span>
        </div>
      </section>

      {/* Measures */}
      <aside className="scroll-quiet min-h-0 overflow-y-auto border-l border-hair px-6 pt-7 pb-10">
        <p className="label text-ink-4">Words</p>
        <p className="display mt-1 text-[112px] tabular-nums">{nf.format(stats.words)}</p>
        <div className="mt-4 flex gap-8">
          <Big label="Characters" value={nf.format(stats.characters)} />
          <Big label="Sentences" value={nf.format(stats.sentences)} />
          <Big label="Paragraphs" value={nf.format(stats.paragraphs)} />
        </div>

        <dl className="mt-8 grid grid-cols-2 border-t border-hair">
          <Stat label="Reading time" value={stats.words ? formatDuration(stats.readingSeconds) : "–"} />
          <Stat label="Speaking time" value={stats.words ? formatDuration(stats.speakingSeconds) : "–"} />
          <Stat label="No spaces" value={nf.format(stats.charactersNoSpaces)} />
          <Stat label="Unique words" value={nf.format(stats.uniqueWords)} />
          <Stat label="Avg. word" value={stats.words ? `${stats.avgWordLength.toFixed(1)} letters` : "–"} />
          <Stat label="Avg. sentence" value={stats.sentences ? `${stats.avgSentenceLength.toFixed(1)} words` : "–"} />
          <Stat label="Longest sentence" value={stats.longestSentence ? `${stats.longestSentence} words` : "–"} />
          <Stat label="Syllables" value={nf.format(stats.syllables)} />
        </dl>

        <section className="mt-8">
          <p className="label text-ink-4">Reading level</p>
          {stats.words >= 3 ? (
            <div className="mt-2 flex items-baseline justify-between gap-4">
              <span className="text-[26px] font-[540] tracking-[-0.03em]">{level.label}</span>
              <span className="label text-ink-3">
                {level.audience} · ease {Math.round(Math.max(0, Math.min(100, stats.readingEase)))}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-ink-3">Write a few sentences to see it.</p>
          )}
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <p className="label text-ink-4">Keyword density</p>
            <SettingsSegmented
              size="xs"
              aria-label="Phrase length"
              value={String(gram)}
              onValueChange={(v) => setGram(Number(v) as 1 | 2 | 3)}
              options={[
                { value: "1", label: "1 word" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
              ]}
            />
          </div>
          {keywords.length ? (
            <ol className="mt-3 flex flex-col">
              {keywords.map((k) => (
                <li key={k.phrase} className="relative flex items-baseline justify-between gap-3 border-b border-hair py-2 text-[13px]">
                  <span className="truncate font-medium">{k.phrase}</span>
                  <span className="label shrink-0 text-ink-3 tabular-nums">
                    {k.count} · {(k.density * 100).toFixed(1)}%
                  </span>
                  <span
                    className="absolute bottom-[-1px] left-0 h-px bg-ink"
                    style={{ width: `${Math.min(100, (k.count / keywords[0].count) * 100)}%` }}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-[13px] text-ink-3">{gram > 1 ? "No phrase is repeated yet." : "Nothing yet."}</p>
          )}
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <p className="label text-ink-4">
              Grammar
              {checking && grammarState === "ready" && text.trim() ? (
                <span className="ml-2 text-ink">{issues.length || "All clear"}</span>
              ) : null}
            </p>
            <SettingsSwitch aria-label="Check grammar" checked={checking} onCheckedChange={setChecking} />
          </div>
          {checking ? (
            grammarState === "loading" ? (
              <p className="mt-3 text-[13px] text-ink-3">Loading the checker…</p>
            ) : grammarState === "error" ? (
              <p className="mt-3 text-[13px] text-signal">The grammar checker couldn't start.</p>
            ) : (
              <ol className="mt-3 flex flex-col">
                {issues.map((i) => (
                  <li
                    key={i.id}
                    id={`issue-${i.id}`}
                    className={cn(
                      "flex flex-col gap-2 border-b border-hair py-3 transition-colors",
                      activeIssue === i.id && "bg-paper-2 -mx-2 px-2",
                    )}
                    onMouseEnter={() => setActiveIssue(i.id)}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-medium">
                        <span className="text-signal line-through decoration-signal/40">{i.problem}</span>
                      </span>
                      <span className="label shrink-0 text-ink-4">{i.kind}</span>
                    </div>
                    <p className="text-[12.5px]/[18px] text-ink-3">{i.message}</p>
                    {i.suggestions.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {i.suggestions.map((s) => (
                          <button
                            key={s.index}
                            onClick={() => void fix(i, s.index)}
                            className="chatcn-focus h-6 rounded-full bg-ink px-2.5 text-[12px] font-medium text-paper transition-opacity hover:opacity-80"
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )
          ) : (
            <p className="mt-3 text-[13px] text-ink-3">Off. Runs on this computer when on.</p>
          )}
        </section>
      </aside>
    </div>
  )
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[26px] font-[540] tracking-[-0.03em] tabular-nums">{value}</p>
      <p className="label text-ink-4">{label}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-hair py-3 odd:pr-4 even:border-l even:pl-4">
      <dt className="label text-ink-4">{label}</dt>
      <dd className="text-[15px] font-medium tracking-[-0.01em] tabular-nums">{value}</dd>
    </div>
  )
}

function Marks({ text, issues, active }: { text: string; issues: Issue[]; active: string | null }) {
  if (!issues.length) return <>{text}</>
  const out: React.ReactNode[] = []
  let at = 0
  for (const i of [...issues].sort((a, b) => a.start - b.start)) {
    if (i.start < at) continue
    out.push(text.slice(at, i.start))
    out.push(
      <mark key={i.id} className={cn("grammar-mark", active === i.id && "is-active")}>
        {text.slice(i.start, Math.max(i.end, i.start + 1))}
      </mark>,
    )
    at = Math.max(i.end, i.start + 1)
  }
  out.push(text.slice(at))
  return <>{out}</>
}
