import { useCallback, useEffect, useState } from "react"
import { Check, Copy, Mic } from "lucide-react"
import { ToolHeader } from "@/components/files"
import { Select } from "@/components/options"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { dictation, pickFiles, type DictationEvent, type DictationSettings, type HistoryItem, type SpeechModel } from "@/lib/engine"
import { announceSaved } from "@/lib/saved"
import { basename, cn, formatBytes } from "@/lib/utils"

const LANGUAGES: [string, string][] = [
  ["auto", "Detect automatically"],
  ["en", "English"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
  ["ko", "Korean"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
]

/** "ctrl+shift+space" → ["Ctrl", "Shift", "Space"] for the key caps. */
function keysOf(shortcut: string): string[] {
  return shortcut.split("+").map((k) => {
    const l = k.toLowerCase()
    if (l === "ctrl" || l === "control") return "Ctrl"
    if (l === "alt" || l === "option") return navigator.userAgent.includes("Mac") ? "⌥" : "Alt"
    if (l === "shift") return "Shift"
    if (l === "super" || l === "meta" || l === "cmd" || l === "command") return navigator.userAgent.includes("Mac") ? "⌘" : "Win"
    return l.length === 1 ? l.toUpperCase() : l[0].toUpperCase() + l.slice(1)
  })
}

/** Turns a keydown into the plugin's shortcut syntax. Needs a modifier and a non-modifier key. */
function comboFrom(e: React.KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push("ctrl")
  if (e.altKey) mods.push("alt")
  if (e.shiftKey) mods.push("shift")
  if (e.metaKey) mods.push("super")
  const code = e.code
  let key: string | null = null
  if (code === "Space") key = "space"
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase()
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code.toLowerCase()
  else if (["Backquote", "Enter", "Tab", "Insert", "Home", "End", "PageUp", "PageDown"].includes(code)) key = code.toLowerCase()
  if (!key) return null
  // Function keys and Insert work alone; anything else needs a modifier so typing isn't hijacked.
  if (!mods.length && !/^f\d+$|^insert$/.test(key)) return null
  return [...mods, key].join("+")
}

export function DictateScreen() {
  const [settings, setSettings] = useState<DictationSettings | null>(null)
  const [models, setModels] = useState<SpeechModel[]>([])
  const [mics, setMics] = useState<{ id: string; name: string; isDefault: boolean }[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [status, setStatus] = useState<DictationEvent>({ state: "idle" })
  const [levels, setLevels] = useState<number[]>(() => Array(28).fill(0))
  const [downloads, setDownloads] = useState<Record<string, { received: number; total: number }>>({})
  const [error, setError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const [fileBusy, setFileBusy] = useState(false)

  const refresh = useCallback(async () => {
    setModels(await dictation.models())
    setHistory(await dictation.history())
  }, [])

  useEffect(() => {
    void dictation.settings().then(setSettings)
    void dictation.microphones().then(setMics)
    void refresh()
  }, [refresh])

  useEffect(() => {
    let off1: (() => void) | undefined
    let off2: (() => void) | undefined
    void dictation
      .onEvent((e) => {
        if (e.state === "recording" && e.level !== undefined) {
          setLevels((l) => [...l.slice(1), e.level!])
          setStatus((s) => (s.state === "recording" ? s : { state: "recording" }))
          return
        }
        setStatus(e)
        if (e.state === "done") void dictation.history().then(setHistory)
        if (e.state !== "recording") setLevels(Array(28).fill(0))
      })
      .then((u) => (off1 = u))
    void dictation
      .onDownload((e) => {
        if (e.state === "downloading") setDownloads((d) => ({ ...d, [e.id]: { received: e.received, total: e.total } }))
        else {
          setDownloads((d) => {
            const n = { ...d }
            delete n[e.id]
            return n
          })
          if (e.state === "failed") setError(e.error ?? "The download failed.")
          void refresh()
        }
      })
      .then((u) => (off2 = u))
    return () => {
      off1?.()
      off2?.()
    }
  }, [refresh])

  const save = async (patch: Partial<DictationSettings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    setError(null)
    try {
      await dictation.save(next)
    } catch (e) {
      setError(String(e))
      if (patch.enabled) setSettings({ ...next, enabled: false })
    }
  }

  if (!settings) return null
  const model = models.find((m) => m.id === settings.model)
  const ready = settings.enabled && !!model?.downloaded
  const keys = keysOf(settings.shortcut)
  const holdWord = settings.mode === "toggle" ? "Tap" : "Hold"

  const statusText =
    status.state === "recording"
      ? "Listening…"
      : status.state === "transcribing"
        ? "Writing it down…"
        : status.state === "error"
          ? status.error
          : !settings.enabled
            ? "Dictation is off."
            : !model?.downloaded
              ? "Download a model to start."
              : settings.mode === "auto"
                ? "Hold to talk, or tap to start and tap again to stop."
                : settings.mode === "hold"
                  ? "Hold the keys while you talk."
                  : "Tap once to start, again to stop."

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="Dictate">
        <p className="max-w-[36ch] text-[13px]/[19px] text-ink-3">
          Speak and your words are typed into any app. Runs on this computer with the same open models as Handy.
        </p>
      </ToolHeader>

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
        {/* The shortcut, the live state, and what was said */}
        <section className="scroll-quiet col-span-7 min-h-0 overflow-y-auto pl-5 pb-10">
          <div className="flex items-center justify-between gap-6 border-b border-hair py-4">
            <span className="label text-ink-4">Dictation</span>
            <label className="flex items-center gap-3 text-[13px] font-medium">
              {settings.enabled ? "On" : "Off"}
              <SettingsSwitch aria-label="Dictation on" checked={settings.enabled} onCheckedChange={(v) => void save({ enabled: v })} />
            </label>
          </div>

          <div className={cn("pt-10 pb-8 transition-opacity", !settings.enabled && "opacity-40")}>
            <p className="display flex flex-wrap items-center gap-x-4 gap-y-3 text-[clamp(44px,5vw,72px)]">
              <span>{holdWord}</span>
              {keys.map((k, i) => (
                <span key={i} className="flex items-center gap-4">
                  {i > 0 ? <span className="text-ink-4">+</span> : null}
                  <kbd className="rounded-2xl border border-hair-strong bg-card px-[0.32em] pt-[0.06em] pb-[0.1em] font-sans text-[0.8em] shadow-[0_2px_0_var(--hair-strong)]">
                    {k}
                  </kbd>
                </span>
              ))}
            </p>
            <p className="display mt-3 text-[clamp(44px,5vw,72px)] text-ghost">and talk.</p>
          </div>

          {/* Live meter */}
          <div className="flex items-end gap-5 border-y border-hair py-5">
            <div className="flex h-10 items-center gap-[3px]" aria-hidden="true">
              {levels.map((l, i) => (
                <span
                  key={i}
                  className={cn("w-[3px] rounded-full transition-[height] duration-75", status.state === "recording" ? "bg-ink" : "bg-ghost")}
                  style={{ height: `${Math.max(3, l * 40)}px` }}
                />
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={cn("label", status.state === "error" ? "text-signal" : status.state === "recording" ? "text-ink" : "text-ink-4")}>
                {status.state === "recording" ? "● Recording" : status.state === "transcribing" ? "Transcribing" : ready ? "Ready" : "Not ready"}
              </span>
              <span className={cn("truncate text-[14px]", status.state === "error" ? "text-signal" : "text-ink-2")}>{statusText}</span>
            </div>
            <Button size="md" variant="outline" disabled={!ready} onClick={() => void dictation.toggle()}>
              <Mic /> {status.state === "recording" ? "Stop" : "Test"}
            </Button>
          </div>

          {error ? <p className="mt-4 text-[13px] text-signal">{error}</p> : null}

          {/* History */}
          <div className="mt-8 flex items-center justify-between">
            <span className="label text-ink-4">Recent</span>
            {history.length ? (
              <button
                className="label focus-ring text-ink-4 transition-colors hover:text-ink"
                onClick={async () => {
                  await dictation.clearHistory()
                  setHistory([])
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          {history.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">What you dictate shows up here, so nothing is lost if it lands in the wrong place.</p>
          ) : (
            <ol className="mt-2 flex flex-col">
              {history.slice(0, 40).map((h, i) => (
                <li key={`${h.at}-${i}`} className="group flex items-start gap-4 border-b border-hair py-3.5">
                  <span className="label w-14 shrink-0 pt-1 text-ink-4">
                    {new Date(h.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <p className="min-w-0 flex-1 text-[15px]/[23px] text-ink select-text">{h.text}</p>
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(h.text)
                      setCopied(i)
                      setTimeout(() => setCopied(null), 1200)
                    }}
                    className="focus-ring grid size-7 shrink-0 place-items-center rounded-lg text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-paper-2 hover:text-ink"
                    aria-label="Copy"
                  >
                    {copied === i ? <Check size={14} /> : <Copy size={14} strokeWidth={1.75} />}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* Models and settings */}
        <section className="scroll-quiet col-span-5 min-h-0 overflow-y-auto border-l border-hair px-5 pb-10">
          <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">Model</div>
          <ul className="flex flex-col">
            {models.map((m) => {
              const dl = downloads[m.id]
              const active = m.id === settings.model
              return (
                <li key={m.id} className="border-b border-hair py-3.5">
                  <div className="flex items-start justify-between gap-4">
                    <button
                      disabled={!m.downloaded}
                      onClick={() => void save({ model: m.id })}
                      className={cn("focus-ring flex min-w-0 flex-col items-start gap-0.5 text-left", !m.downloaded && "cursor-default")}
                    >
                      <span className={cn("flex items-baseline gap-2 text-[20px] font-[540] tracking-[-0.025em]", active && m.downloaded ? "text-ink" : m.downloaded ? "text-ink-3 hover:text-ink" : "text-ink-3")}>
                        {m.name}
                        {active && m.downloaded ? <span className="label text-ink">In use</span> : null}
                        {m.recommended && !(active && m.downloaded) ? <span className="label text-ink-4">Recommended</span> : null}
                      </span>
                      <span className="text-[12.5px]/[18px] text-ink-3">{m.description}</span>
                      <span className="label text-ink-4">
                        {m.languages} · {formatBytes(m.size)}
                      </span>
                    </button>
                    <div className="shrink-0 pt-1">
                      {dl ? (
                        <Button size="sm" variant="ghost" onClick={() => void dictation.cancelDownload()}>
                          {Math.round((dl.received / Math.max(1, dl.total)) * 100)}% · Cancel
                        </Button>
                      ) : m.downloaded ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await dictation.remove(m.id)
                            void refresh()
                          }}
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDownloads((d) => ({ ...d, [m.id]: { received: 0, total: m.size } }))
                            void dictation.download(m.id)
                            if (!models.some((x) => x.downloaded)) void save({ model: m.id })
                          }}
                        >
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                  {dl ? (
                    <div className="relative mt-3 h-px bg-hair">
                      <div className="absolute inset-y-0 left-0 bg-ink transition-[width]" style={{ width: `${(dl.received / Math.max(1, dl.total)) * 100}%` }} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>

          <div className="label mt-8 py-3 text-ink-4">Settings</div>
          <div className="divide-y divide-hair border-t border-hair">
            <SettingsRow label="Shortcut" description="Click, then press the keys you want.">
              <button
                onFocus={() => setCapturing(true)}
                onBlur={() => setCapturing(false)}
                onKeyDown={(e) => {
                  e.preventDefault()
                  if (e.key === "Escape") return (e.target as HTMLElement).blur()
                  const combo = comboFrom(e)
                  if (combo) {
                    void save({ shortcut: combo })
                    ;(e.target as HTMLElement).blur()
                  }
                }}
                className={cn(
                  "chatcn-focus h-8 min-w-28 rounded-md px-3 font-mono text-[12px] transition-colors",
                  capturing ? "bg-ink text-paper" : "bg-paper-2 text-ink hover:bg-paper-3",
                )}
              >
                {capturing ? "Press keys…" : keys.join(" + ")}
              </button>
            </SettingsRow>
            <SettingsRow label="How the keys work">
              <SettingsSegmented
                size="xs"
                value={settings.mode}
                onValueChange={(v) => void save({ mode: v as DictationSettings["mode"] })}
                options={[
                  { value: "auto", label: "Hold or tap" },
                  { value: "hold", label: "Hold" },
                  { value: "toggle", label: "Tap" },
                ]}
              />
            </SettingsRow>
            <SettingsRow label="Language" description="Pick one if detection gets it wrong.">
              <Select aria-label="Language" value={settings.language} onChange={(v) => void save({ language: v })} options={LANGUAGES.map(([value, label]) => ({ value, label }))} />
            </SettingsRow>
            <SettingsRow label="Where the words go">
              <SettingsSegmented
                size="xs"
                value={settings.output}
                onValueChange={(v) => void save({ output: v as DictationSettings["output"] })}
                options={[
                  { value: "paste", label: "Type into the app" },
                  { value: "copy", label: "Copy only" },
                ]}
              />
            </SettingsRow>
            <SettingsRow label="Microphone">
              <Select
                aria-label="Microphone"
                value={settings.microphone ?? ""}
                onChange={(v) => void save({ microphone: v || null })}
                options={[{ value: "", label: "System default" }, ...mics.map((m) => ({ value: m.id, label: m.name }))]}
                className="max-w-56"
              />
            </SettingsRow>
            <SettingsRow label="Remove filler words" description="Drops um, uh and er.">
              <SettingsSwitch checked={settings.removeFillers} onCheckedChange={(v) => void save({ removeFillers: v })} />
            </SettingsRow>
            <SettingsRow label="Sounds" description="A soft tone when recording starts and stops.">
              <SettingsSwitch checked={settings.sounds} onCheckedChange={(v) => void save({ sounds: v })} />
            </SettingsRow>
            <SettingsRow label="Show the recording pill" description="A small bar above the taskbar while you talk.">
              <SettingsSwitch checked={settings.overlay} onCheckedChange={(v) => void save({ overlay: v })} />
            </SettingsRow>
            <SettingsRow label="Words to get right" description="Names and jargon, separated by commas." stacked>
              <input
                defaultValue={settings.vocabulary.join(", ")}
                onBlur={(e) =>
                  void save({
                    vocabulary: e.target.value
                      .split(",")
                      .map((w) => w.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Morf, Kubernetes, Giancarlo"
                className="chatcn-focus h-9 w-full rounded-md bg-paper-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
              />
            </SettingsRow>
          </div>

          <div className="label mt-8 py-3 text-ink-4">Transcribe a recording</div>
          <div className="flex items-center justify-between gap-4 border-t border-hair py-4">
            <p className="text-[13px]/[19px] text-ink-3">Turn a voice memo, interview or video into a text file and subtitles.</p>
            <Button
              size="md"
              variant="outline"
              disabled={fileBusy || !model?.downloaded}
              onClick={async () => {
                const [path] = await pickFiles()
                if (!path) return
                setFileBusy(true)
                setError(null)
                try {
                  const r = await dictation.transcribeFile(path, settings.model, settings.language)
                  announceSaved("Dictate", [{ path: r.txt }, ...(r.srt ? [{ path: r.srt }] : [])], `From ${basename(path)}`)
                } catch (e) {
                  setError(String(e))
                } finally {
                  setFileBusy(false)
                }
              }}
            >
              {fileBusy ? "Transcribing…" : "Choose file"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}

export default DictateScreen
