import { useCallback, useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { CommandPalette } from "@/components/shell/CommandPalette"
import { SavedToast } from "@/components/shell/SavedToast"
import { SettingsDialog, type SettingsSection } from "@/components/shell/SettingsDialog"
import { TitleBar } from "@/components/shell/TitleBar"
import { inspect, onOpenFiles, onWindowDrop, type FileInfo } from "@/lib/engine"
import { handOff } from "@/lib/handoff"
import { getPrefs, loadJSON, saveJSON, setPref } from "@/lib/prefs"
import { scheduleUpdateCheck } from "@/lib/updater"
import { addPaths } from "@/lib/queue"
import { useApplyTheme } from "@/lib/theme"
import { TOOLS, getTool, type ToolId } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { CompressScreen } from "@/screens/CompressScreen"
import { ConvertScreen } from "@/screens/ConvertScreen"
import { CountScreen } from "@/screens/CountScreen"
import { CompareScreen } from "@/screens/CompareScreen"
import { CutoutScreen } from "@/screens/CutoutScreen"
import { DictateScreen } from "@/screens/DictateScreen"
import { PaletteScreen } from "@/screens/PaletteScreen"
import { PdfScreen } from "@/screens/PdfScreen"
import { QrScreen } from "@/screens/QrScreen"
import { ReadScreen } from "@/screens/ReadScreen"
import { RenameScreen } from "@/screens/RenameScreen"
import { ResizeScreen } from "@/screens/ResizeScreen"
import { IndexScreen } from "@/screens/IndexScreen"
import { SoonScreen } from "@/screens/SoonScreen"

/** Tools that handle dropped files on their own screen. */
const SELF_DROP = new Set<ToolId>(["rename", "diff", "qr", "palette", "ocr", "cutout", "pdf"])
/** Self-drop tools that also accept files handed over before their screen opens. */
const TAKES_HANDOFF = new Set<ToolId>(["pdf", "ocr"])
/** Tools whose screen shows its own drop target, so the full-window hint isn't needed. */
const OWN_DROP_UI = new Set<ToolId>(["convert", "compress", "resize", ...SELF_DROP])

export default function App() {
  useApplyTheme()
  const [route, setRoute] = useState<ToolId | null>(() => {
    if (getPrefs().startOn !== "last") return null
    const last = loadJSON<ToolId | null>("route.last", null)
    return last && TOOLS.some((t) => t.id === last) ? last : null
  })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general")
  const openSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  useEffect(() => saveJSON("route.last", route), [route])
  useEffect(() => scheduleUpdateCheck(), [])
  const [dragging, setDragging] = useState(false)
  /** Files dropped on the index wait here while the person picks a tool. */
  const [pending, setPending] = useState<{ paths: string[]; infos: FileInfo[] } | null>(null)

  const open = useCallback((id: ToolId | null) => setRoute(id), [])
  const toggleTheme = useCallback(() => {
    const dark = document.documentElement.classList.contains("dark")
    setPref("theme", dark ? "light" : "dark")
  }, [])

  // Keyboard: palette, settings, back, and Ctrl+1…9 for the first nine tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const t = TOOLS.find((x) => x.shortcut === e.key)
        if (t) {
          e.preventDefault()
          setRoute(t.id)
        }
      } else if (e.key === "Escape" && !paletteOpen && !settingsOpen && route) {
        const tag = (e.target as HTMLElement).tagName
        if (tag !== "TEXTAREA" && tag !== "INPUT") setRoute(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [paletteOpen, settingsOpen, route])

  // Dropped files: straight into the open tool, or ask which tool on the index.
  // The listeners below are registered once, so they read the route through a ref.
  const routeRef = useRef(route)
  routeRef.current = route
  const routeFiles = useCallback(async (paths: string[], tool: string | null) => {
    if (!paths.length) return
    const target = (tool as ToolId | null) ?? routeRef.current
    // These tools listen for drops themselves while open; otherwise open them with the files.
    if (target && SELF_DROP.has(target)) {
      if (tool && TAKES_HANDOFF.has(target)) {
        handOff(target, paths)
        setRoute(target)
      }
      return
    }
    if (target === "resize") {
      await addPaths("resize", paths)
      return
    }
    if (target === "convert" || target === "compress") {
      setRoute(target)
      await addPaths(target, paths)
      return
    }
    const infos = await inspect(paths)
    setPending({ paths, infos })
  }, [])

  // Registration is async: if the effect is cleaned up first, unlisten as soon as it resolves.
  useEffect(() => {
    let off: (() => void) | undefined
    let off2: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => void routeFiles(p, null) }).then((u) => (dead ? u() : (off = u)))
    void onOpenFiles((p, tool) => void routeFiles(p, tool)).then((u) => (dead ? u() : (off2 = u)))
    return () => {
      dead = true
      off?.()
      off2?.()
    }
  }, [routeFiles])

  const screen = (() => {
    if (!route) return <IndexScreen onOpen={open} />
    if (route === "convert") return <ConvertScreen dragging={dragging} />
    if (route === "compress") return <CompressScreen dragging={dragging} />
    if (route === "count") return <CountScreen />
    if (route === "transcribe") return <DictateScreen />
    if (route === "resize") return <ResizeScreen dragging={dragging} />
    if (route === "rename") return <RenameScreen />
    if (route === "diff") return <CompareScreen />
    if (route === "qr") return <QrScreen />
    if (route === "palette") return <PaletteScreen />
    if (route === "ocr") return <ReadScreen />
    if (route === "cutout") return <CutoutScreen />
    if (route === "pdf") return <PdfScreen />
    return <SoonScreen id={route} onBack={() => open(null)} />
  })()

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <TitleBar route={route} onHome={() => open(null)} onSearch={() => setPaletteOpen(true)} onSettings={openSettings} />
      <div key={route ?? "index"} className="anim-fade relative min-h-0 flex-1">
        {screen}
        {/* On screens without their own drop target, show a full-window hint. */}
        {dragging && (route === null || !OWN_DROP_UI.has(route)) ? (
          <div className="anim-fade pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-2xl border border-dashed border-ink/30 bg-paper/85 backdrop-blur-sm">
            <p className="display text-[clamp(56px,8vw,120px)]">Let go</p>
          </div>
        ) : null}
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenTool={open}
        onSettings={openSettings}
        onToggleTheme={toggleTheme}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} section={settingsSection} onSectionChange={setSettingsSection} />
      <SavedToast />
      <ChooseTool
        pending={pending}
        onClose={() => setPending(null)}
        onPick={async (id) => {
          const p = pending
          setPending(null)
          if (!p) return
          if (TAKES_HANDOFF.has(id)) handOff(id, p.paths)
          setRoute(id)
          if (id === "convert" || id === "compress" || id === "resize") await addPaths(id, p.paths)
        }}
      />
    </div>
  )
}

/** After a drop on the index: which tool should take these files? */
function ChooseTool({
  pending,
  onClose,
  onPick,
}: {
  pending: { paths: string[]; infos: FileInfo[] } | null
  onClose: () => void
  onPick: (id: ToolId) => void
}) {
  const n = pending?.paths.length ?? 0
  const kinds = new Set(pending?.infos.map((i) => i.kind))
  const onlyImages = !!pending && pending.infos.every((i) => i.kind === "image")
  const onlyPdfs = !!pending && pending.infos.every((i) => i.kind === "pdf")
  const choices: ToolId[] = onlyPdfs ? ["pdf", "compress", "ocr"] : onlyImages ? ["convert", "compress", "resize", "ocr"] : ["convert", "compress"]
  const reason = (id: ToolId) =>
    id === "convert"
      ? kinds.has("document") || kinds.has("font")
        ? "Change the format (documents and fonts are coming)"
        : "Change the format"
      : id === "resize"
        ? "Change the dimensions"
        : id === "pdf"
          ? "Merge, split, organise, sign, protect"
          : id === "ocr"
            ? "Pull out the text"
            : n === 1
              ? "Make it smaller"
              : "Make them smaller"
  return (
    <Dialog.Root open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-paper/70 backdrop-blur-sm transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="on-card fixed top-1/2 left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-7 shadow-float outline-none transition-[opacity,scale] duration-200 ease-out-quint data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
          <Dialog.Title className="label text-ink-4">
            {n} {n === 1 ? "file" : "files"} · {[...kinds].join(", ")}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[22px] tracking-[-0.02em] text-ink">What should Morf do?</Dialog.Description>
          <div className="mt-6 flex flex-col">
            {choices.map((id, i) => (
              <button
                key={id}
                autoFocus={i === 0}
                onClick={() => onPick(id)}
                className={cn(
                  "group focus-visible:outline-none flex items-baseline justify-between gap-4 border-t border-hair py-3 text-left",
                )}
              >
                <span className="display text-[56px] text-ghost transition-colors duration-150 group-hover:text-ink group-focus-visible:text-ink">
                  {getTool(id).name}
                </span>
                <span className="label text-ink-4 transition-colors group-hover:text-ink-2">{reason(id)}</span>
              </button>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

