import { useEffect, useMemo, useRef, useState } from "react"
import { setPref, usePrefs } from "@/lib/prefs"
import { CATEGORIES, TOOLS, type Tool, type ToolCategory, type ToolId } from "@/lib/tools"
import { cn } from "@/lib/utils"

/**
 * The first screen. A studio index: the tools as one giant column of type, greyed out until
 * pointed at; the one in focus turns to ink and its description appears on the left.
 */
export function IndexScreen({ onOpen }: { onOpen: (id: ToolId) => void }) {
  const { indexView } = usePrefs()
  const [category, setCategory] = useState<ToolCategory | "all">("all")
  const tools = useMemo(() => TOOLS.filter((t) => category === "all" || t.category === category), [category])
  const [activeId, setActiveId] = useState<ToolId>("convert")
  const active = tools.find((t) => t.id === activeId) ?? tools[0]

  // Arrow keys walk the list; Enter opens. Ignored while typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const i = tools.findIndex((t) => t.id === active?.id)
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault()
        setActiveId(tools[Math.min(tools.length - 1, i + 1)].id)
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault()
        setActiveId(tools[Math.max(0, i - 1)].id)
      } else if (e.key === "Enter" && active) {
        onOpen(active.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [tools, active, onOpen])

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: TOOLS.length }
    for (const t of TOOLS) m[t.category] = (m[t.category] ?? 0) + 1
    return m
  }, [])

  const filters = (
    <div className="flex gap-10">
      <div className="flex flex-col gap-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={cn(
              "label focus-ring flex w-fit items-start gap-1 text-left transition-colors hover:text-ink",
              category === c.id ? "text-ink" : "text-ink-4",
            )}
          >
            {c.label}
            <span className="text-[8.5px] leading-[10px]">{counts[c.id]}</span>
          </button>
        ))}
      </div>
    </div>
  )

  const viewToggle = (
    <div className="label flex items-center gap-4">
      {(["grid", "list"] as const).map((v, i) => (
        <span key={v} className="flex items-center gap-4">
          {i > 0 ? <span className="text-ink-4">/</span> : null}
          <button
            onClick={() => setPref("indexView", v)}
            className={cn("focus-ring transition-colors hover:text-ink", indexView === v ? "text-ink" : "text-ink-4")}
          >
            {v}
          </button>
        </span>
      ))}
    </div>
  )

  if (indexView === "grid") return <GridIndex tools={tools} filters={filters} viewToggle={viewToggle} onOpen={onOpen} />

  return (
    <main className="grid h-full min-h-0 grid-cols-12 gap-x-5 px-5">
      <aside className="col-span-4 flex min-h-0 flex-col pt-8 pb-6 xl:col-span-3">
        {filters}
        <div className="mt-auto flex flex-col gap-6">
          {viewToggle}
          {active ? <ActivePreview tool={active} onOpen={onOpen} /> : null}
        </div>
      </aside>

      <section className="scroll-quiet relative col-span-8 min-h-0 overflow-y-auto pb-[30vh] pt-6 xl:col-span-8 xl:col-start-5">
        <ul className="flex flex-col" onMouseLeave={() => undefined}>
          {tools.map((t, i) => (
            <li key={t.id} className="anim-rise" style={{ animationDelay: `${i * 28}ms` }}>
              <NameRow tool={t} active={t.id === active?.id} onHover={() => setActiveId(t.id)} onOpen={() => onOpen(t.id)} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}

function NameRow({ tool, active, onHover, onOpen }: { tool: Tool; active: boolean; onHover: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [active])
  return (
    <button
      ref={ref}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onOpen}
      className={cn(
        "display group focus-visible:outline-none flex items-start gap-2 py-[0.035em] text-left text-[clamp(52px,7vw,112px)]",
        "transition-colors duration-200",
        active ? "text-ink" : "text-ghost hover:text-ink-4",
      )}
    >
      <span>{tool.name}</span>
      {tool.ready && tool.count ? (
        <sup
          className={cn(
            "mt-[calc(clamp(52px,7vw,112px)*0.25)] font-serif text-[clamp(16px,1.6vw,24px)] font-normal tracking-normal transition-colors duration-200",
            active ? "text-ink" : "text-ghost",
          )}
        >
          ({tool.count})
        </sup>
      ) : !tool.ready ? (
        <sup className={cn("label mt-[calc(clamp(52px,7vw,112px)*0.17)] transition-colors", active ? "text-ink-3" : "text-ghost")}>Soon</sup>
      ) : null}
    </button>
  )
}

function ActivePreview({ tool, onOpen }: { tool: Tool; onOpen: (id: ToolId) => void }) {
  return (
    <div key={tool.id} className="anim-fade flex max-w-[300px] flex-col gap-4">
      <p className="text-[22px]/[29px] tracking-[-0.02em] text-ink-2 text-pretty">{tool.blurb}</p>
      <button
        onClick={() => onOpen(tool.id)}
        className="label focus-ring flex w-fit items-center gap-3 text-ink-3"
        aria-label={`Open ${tool.name}`}
      >
        {tool.ready ? (
          <>
            <span className="text-ink">Open ↵</span>
            {tool.count ? (
              <span>
                {tool.count} {tool.countLabel}
              </span>
            ) : null}
          </>
        ) : (
          <span>In the works</span>
        )}
      </button>
    </div>
  )
}

function GridIndex({
  tools,
  filters,
  viewToggle,
  onOpen,
}: {
  tools: Tool[]
  filters: React.ReactNode
  viewToggle: React.ReactNode
  onOpen: (id: ToolId) => void
}) {
  return (
    <main className="scroll-quiet h-full min-h-0 overflow-y-auto px-5 pb-10">
      <div className="grid grid-cols-12 gap-x-5 pt-10 pb-12">
        <h1 className="display col-span-6 text-[clamp(72px,10vw,150px)] anim-rise">Tools</h1>
        <div className="col-span-3 col-start-7 flex gap-6 self-end pb-3">
          <span className="label text-ink">Category</span>
          {filters}
        </div>
        <div className="col-span-3 flex gap-6 self-end pb-3">
          <span className="label text-ink">View</span>
          {viewToggle}
        </div>
      </div>
      {/* Type-only tiles: number, name, one line. Hairlines carry the grid. */}
      <div className="grid grid-cols-2 border-t border-l border-hair md:grid-cols-3 xl:grid-cols-4">
        {tools.map((t, i) => (
          <button
            key={t.id}
            onClick={() => onOpen(t.id)}
            className="group focus-ring anim-rise flex min-h-[220px] flex-col justify-between gap-6 border-r border-b border-hair p-5 text-left transition-colors duration-200 hover:bg-paper-2"
            style={{ animationDelay: `${i * 30}ms` }}
          >
            <span className="label flex w-full justify-between text-ink-4">
              <span className="tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span>{t.ready ? `${t.count ?? ""} ${t.countLabel ?? ""}` : "Soon"}</span>
            </span>
            <span className="flex flex-col gap-2">
              <span
                className={cn(
                  "display text-[44px] transition-colors duration-200",
                  t.ready ? "text-ink" : "text-ghost group-hover:text-ink-4",
                )}
              >
                {t.name}
              </span>
              <span className="max-w-[30ch] text-[13px]/[19px] text-ink-3 text-pretty">{t.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    </main>
  )
}
