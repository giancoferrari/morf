import { useEffect, useMemo, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { TOOLS, type ToolId } from "@/lib/tools"
import { cn } from "@/lib/utils"

interface Command {
  id: string
  label: string
  hint: string
  section: "Tools" | "Soon" | "Actions"
  run: () => void
  keywords: string
}

/**
 * ⌘K / Ctrl+K. Type to filter tools and actions; arrows move, Enter runs. Matching is by
 * substring over the name, then the keywords, so "mp3", "shrink" or "grammar" all find a tool.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenTool,
  onSettings,
  onToggleTheme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTool: (id: ToolId) => void
  onSettings: () => void
  onToggleTheme: () => void
}) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const tools: Command[] = TOOLS.map((t) => ({
      id: t.id,
      label: t.name,
      hint: t.blurb,
      section: t.ready ? "Tools" : "Soon",
      run: () => onOpenTool(t.id),
      keywords: `${t.name} ${t.keywords.join(" ")} ${t.blurb}`.toLowerCase(),
    }))
    const actions: Command[] = [
      { id: "settings", label: "Settings", hint: "Output folder, theme, hardware encoding", section: "Actions", run: onSettings, keywords: "settings preferences options" },
      { id: "theme", label: "Toggle theme", hint: "Switch between light and dark", section: "Actions", run: onToggleTheme, keywords: "dark light theme mode appearance" },
    ]
    return [...tools, ...actions]
  }, [onOpenTool, onSettings, onToggleTheme])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    const starts = commands.filter((c) => c.label.toLowerCase().startsWith(q))
    const rest = commands.filter((c) => !starts.includes(c) && c.keywords.includes(q))
    return [...starts, ...rest]
  }, [commands, query])

  useEffect(() => setActive(0), [query, open])
  useEffect(() => {
    if (!open) setQuery("")
  }, [open])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const run = (c: Command | undefined) => {
    if (!c) return
    onOpenChange(false)
    c.run()
  }

  let lastSection = ""
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-paper/60 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed top-[14vh] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl bg-card shadow-float outline-none",
            "transition-[opacity,transform] duration-200 ease-out-quint data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1.5 data-[starting-style]:opacity-0",
          )}
        >
          <Dialog.Title className="sr-only">Search tools and actions</Dialog.Title>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                run(results[active])
              }
            }}
            placeholder="Find a tool, a format, an action…"
            className="h-16 w-full border-b border-hair bg-transparent px-6 text-[22px] tracking-[-0.02em] text-ink outline-none placeholder:text-ink-4"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          />
          <div ref={listRef} id="palette-list" role="listbox" className="scroll-quiet max-h-[52vh] overflow-y-auto py-2">
            {results.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-ink-3">Nothing matches “{query}”.</p>
            ) : (
              results.map((c, i) => {
                const header = c.section !== lastSection ? c.section : null
                lastSection = c.section
                return (
                  <div key={c.id}>
                    {header ? <div className="label px-6 pt-3 pb-1.5 text-ink-4">{header}</div> : null}
                    <div
                      id={`cmd-${c.id}`}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      onMouseMove={() => setActive(i)}
                      onClick={() => run(c)}
                      className={cn(
                        "mx-2 flex cursor-default items-baseline gap-4 rounded-lg px-4 py-2.5",
                        i === active ? "bg-paper-2" : "",
                      )}
                    >
                      <span className={cn("w-28 shrink-0 text-[15px] font-medium tracking-[-0.01em]", c.section === "Soon" ? "text-ink-3" : "text-ink")}>
                        {c.label}
                      </span>
                      <span className="truncate text-[13px] text-ink-3">{c.hint}</span>
                      {c.section === "Soon" ? <span className="label ml-auto shrink-0 text-ink-4">Soon</span> : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
          <div className="label flex gap-5 border-t border-hair px-6 py-3 text-ink-4">
            <span>↑↓ Move</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
