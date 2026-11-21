import { useEffect, useState } from "react"
import { Minus, Moon, Square, Sun, X, Copy } from "lucide-react"
import { Wordmark } from "@/components/Logo"
import { inTauri } from "@/lib/engine"
import { setPref, usePrefs } from "@/lib/prefs"
import { getTool, type ToolId } from "@/lib/tools"
import { cn, isMac, modKey } from "@/lib/utils"

/**
 * The window's top edge: wordmark and breadcrumb on the start side, palette, settings and theme
 * on the end side. The window has no system frame on Windows, so this bar is also its drag
 * handle and carries the three window buttons. On macOS the traffic lights sit over the start.
 */
export function TitleBar({
  route,
  onHome,
  onSearch,
  onSettings,
}: {
  route: ToolId | null
  onHome: () => void
  onSearch: () => void
  onSettings: () => void
}) {
  const { theme } = usePrefs()
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const tool = route ? getTool(route) : null

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-30 flex h-11 shrink-0 items-center gap-6 pr-0",
        isMac && inTauri ? "pl-[84px]" : "pl-5",
      )}
    >
      <button onClick={onHome} className="focus-ring no-drag text-ink transition-opacity hover:opacity-60" aria-label="Morf, back to the index">
        <Wordmark size={17} />
      </button>

      <nav data-tauri-drag-region className="label flex items-center gap-2 text-ink-3" aria-label="Location">
        <button
          onClick={onHome}
          className={cn("focus-ring no-drag transition-colors hover:text-ink", !tool && "text-ink")}
        >
          Index
        </button>
        {tool ? (
          <>
            <span className="text-ink-4">/</span>
            <span className="text-ink">{tool.name}</span>
          </>
        ) : null}
      </nav>

      <div data-tauri-drag-region className="flex-1 self-stretch" />

      <div className="no-drag flex items-center gap-5">
        <button onClick={onSearch} className="label focus-ring flex items-center gap-2 text-ink-3 transition-colors hover:text-ink">
          Search
          <kbd className="rounded-[4px] border border-hair-strong px-1 py-px font-mono text-[10px] leading-3 tracking-normal normal-case">
            {modKey} K
          </kbd>
        </button>
        <button onClick={onSettings} className="label focus-ring text-ink-3 transition-colors hover:text-ink">
          Settings
        </button>
        <button
          onClick={() => setPref("theme", dark ? "light" : "dark")}
          className="focus-ring grid size-6 place-items-center text-ink-3 transition-colors hover:text-ink"
          aria-label={dark ? "Use light theme" : "Use dark theme"}
          title={theme === "system" ? "Following system" : undefined}
        >
          {dark ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
        </button>
      </div>

      {inTauri && !isMac ? <WindowButtons /> : <div className="w-3" />}
    </header>
  )
}

function WindowButtons() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let off: (() => void) | undefined
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      const w = getCurrentWindow()
      setMaximized(await w.isMaximized())
      off = await w.onResized(async () => setMaximized(await w.isMaximized()))
    })()
    return () => off?.()
  }, [])
  const call = async (fn: "minimize" | "toggleMaximize" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow()[fn]()
  }
  const btn = "no-drag grid h-11 w-11 place-items-center text-ink-2 transition-colors duration-100"
  return (
    <div className="flex">
      <button className={cn(btn, "hover:bg-paper-3")} onClick={() => call("minimize")} aria-label="Minimize">
        <Minus size={14} strokeWidth={1.25} />
      </button>
      <button className={cn(btn, "hover:bg-paper-3")} onClick={() => call("toggleMaximize")} aria-label={maximized ? "Restore" : "Maximize"}>
        {maximized ? <Copy size={11} strokeWidth={1.25} className="-scale-x-100" /> : <Square size={11} strokeWidth={1.25} />}
      </button>
      <button className={cn(btn, "hover:bg-[#c42b1c] hover:text-white")} onClick={() => call("close")} aria-label="Close">
        <X size={15} strokeWidth={1.25} />
      </button>
    </div>
  )
}
