import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowUpRight, ChevronLeft, ChevronRight, Eye, EyeOff, RotateCcw, RotateCw, Trash2, X } from "lucide-react"
import { ToolHeader } from "@/components/files"
import { DrawPad, INKS, TypePad, type Ink } from "@/components/SignaturePad"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import { files as fileApi, inspect, onWindowDrop, pickFiles } from "@/lib/engine"
import {
  chunk,
  folderBeside,
  LockedError,
  merge,
  openPdf,
  pageAspect,
  pageImage,
  parseRanges,
  pdfPasswords,
  PDF_IMAGE_EXTS,
  pick,
  rangeLabel,
  sign,
  forget,
  type Placement,
} from "@/lib/pdf"
import { takeHandoff } from "@/lib/handoff"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { move, useReorder } from "@/lib/reorder"
import { announceSaved } from "@/lib/saved"
import { basename, cn, extname, formatBytes } from "@/lib/utils"

type Action = "merge" | "split" | "organise" | "sign" | "protect" | "unlock"

const ACTIONS: { id: Action; name: string; note: string }[] = [
  { id: "merge", name: "Merge", note: "Joins PDFs and pictures into one file, in the order shown. Drag rows to reorder." },
  { id: "split", name: "Split", note: "Breaks a PDF into smaller files: every page, every few pages, or the ranges you choose." },
  { id: "organise", name: "Organise", note: "Reorder, turn and remove pages. Drag a page to move it; click to select." },
  { id: "sign", name: "Sign", note: "Draw or type your signature and place it on any page." },
  { id: "protect", name: "Protect", note: "Adds a password that's needed to open the file, and limits printing and copying." },
  { id: "unlock", name: "Unlock", note: "Removes a password you know, so the file opens without it." },
]

/** Actions that work on one file at a time, shown large on the left. */
const SINGLE = new Set<Action>(["organise", "sign"])

interface Item {
  id: string
  path: string
  name: string
  size: number
  kind: "pdf" | "image"
  pages?: number
  locked?: boolean
  problem?: string
}

const kept: { items: Item[]; selectedId: string | null } = { items: [], selectedId: null }

let seq = 0
const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, "")
const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/")
const stemOf = (p: string) => basename(p).replace(/\.[^.]+$/, "")
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.split(",")[1])
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function PdfScreen() {
  const [action, setActionState] = useState<Action>(() => loadJSON("pdf.action", "merge"))
  const setAction = (a: Action) => {
    setActionState(a)
    saveJSON("pdf.action", a)
    setError(null)
  }
  // Kept outside the screen, like the Convert and Compress queues, so files survive a trip elsewhere.
  const [items, setItems] = useState<Item[]>(() => kept.items)
  const [selectedId, setSelectedId] = useState<string | null>(() => kept.selectedId)
  useEffect(() => {
    kept.items = items
    kept.selectedId = selectedId
  }, [items, selectedId])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pdfs = items.filter((i) => i.kind === "pdf" && !i.problem)
  const selected = pdfs.find((i) => i.id === selectedId) ?? pdfs[0] ?? null

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setError(null)
    const infos = await inspect(paths)
    const fresh: Item[] = infos.map((f) => {
      const ext = extname(f.path)
      const kind = ext === "pdf" || f.kind === "pdf" ? "pdf" : PDF_IMAGE_EXTS.includes(ext) || f.kind === "image" ? "image" : null
      return {
        id: newId(),
        path: f.path,
        name: f.name,
        size: f.size,
        kind: kind ?? "pdf",
        problem: kind ? undefined : "Not a PDF or a picture.",
      }
    })
    setItems((list) => [...list, ...fresh.filter((f) => !list.some((x) => x.path === f.path))])
    // Count pages, and find the locked ones.
    for (const it of fresh) {
      if (it.kind !== "pdf" || it.problem) continue
      forget(it.path)
      openPdf(it.path)
        .then((d) => setItems((l) => l.map((x) => (x.id === it.id ? { ...x, pages: d.numPages } : x))))
        .catch((e) =>
          setItems((l) => l.map((x) => (x.id === it.id ? (e instanceof LockedError ? { ...x, locked: true } : { ...x, problem: "Morf can't read this PDF." }) : x))),
        )
    }
  }, [])

  // Files dropped on the index or sent from the right-click menu before this screen opened.
  useEffect(() => {
    const waiting = takeHandoff("pdf")
    if (waiting.length) void add(waiting)
  }, [add])

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({ over: setDragging, drop: (p) => void add(p) }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
  }, [add])

  const choose = async () => add(await pickFiles([{ name: "PDFs and pictures", extensions: ["pdf", ...PDF_IMAGE_EXTS] }]))

  const remove = (id: string) => setItems((l) => l.filter((x) => x.id !== id))
  const current = ACTIONS.find((a) => a.id === action)!
  const totalPages = items.reduce((n, i) => n + (i.kind === "image" ? 1 : (i.pages ?? 0)), 0)

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(null)
    }
  }

  const meta = items.length ? (
    <div className="label flex gap-6 text-ink-3">
      <span>
        <span className="text-ink">{items.length}</span> {items.length === 1 ? "file" : "files"}
      </span>
      {totalPages ? <span>{plural(totalPages, "page")}</span> : null}
      <span>{formatBytes(items.reduce((n, i) => n + i.size, 0))}</span>
    </div>
  ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="PDF" meta={meta}>
        <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Merge, split, organise, sign and protect PDFs. Everything happens on this computer.</p>
      </ToolHeader>

      {items.length === 0 ? (
        <Empty dragging={dragging} onChoose={() => void choose()} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          <section className={cn("col-span-7 flex min-h-0 flex-col transition-colors", dragging && "bg-paper-2")}>
            {SINGLE.has(action) ? (
              <>
                <FileTabs items={pdfs} selected={selected} onSelect={setSelectedId} onAdd={() => void choose()} />
                {selected ? (
                  selected.locked ? (
                    <Locked onUnlock={() => setAction("unlock")} />
                  ) : action === "organise" ? (
                    <Organise key={selected.id} item={selected} busy={!!busy} run={run} />
                  ) : (
                    <Sign key={selected.id} item={selected} busy={!!busy} run={run} />
                  )
                ) : (
                  <p className="px-5 py-6 text-[15px] text-ink-3">Add a PDF to {action === "sign" ? "sign" : "organise"}.</p>
                )}
              </>
            ) : (
              <FileList
                items={items}
                action={action}
                busy={!!busy}
                dragging={dragging}
                onRemove={remove}
                onClear={() => setItems([])}
                onMove={(a, b) => setItems((l) => move(l, a, b))}
                onAdd={() => void choose()}
              />
            )}
          </section>

          <section className="col-span-5 flex min-h-0 flex-col border-l border-hair">
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <div className="label sticky top-0 z-10 bg-paper py-3 text-ink-4">Action</div>
              <div className="flex flex-wrap gap-x-4">
                {ACTIONS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAction(a.id)}
                    className={cn("focus-ring text-[30px]/[1.15] font-[540] tracking-[-0.035em] transition-colors", a.id === action ? "text-ink" : "text-ghost hover:text-ink-4")}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
              <p key={action} className="anim-fade mt-2 max-w-[46ch] text-[13px]/[19px] text-ink-3">
                {current.note}
              </p>
              {/* Per-action options mount here through portals from the left side; the simple ones live below. */}
              <div id="pdf-options" className="mt-6" />
              {action === "merge" ? <MergeOptions items={items} busy={!!busy} run={run} /> : null}
              {action === "split" ? <SplitOptions items={pdfs.filter((p) => !p.locked)} busy={!!busy} run={run} /> : null}
              {action === "protect" ? <ProtectOptions items={pdfs.filter((p) => !p.locked)} busy={!!busy} run={run} /> : null}
              {action === "unlock" ? <UnlockOptions items={pdfs.filter((p) => p.locked)} busy={!!busy} run={run} onDone={(ids) => setItems((l) => l.filter((x) => !ids.includes(x.id)))} /> : null}
              {error ? <p className="anim-fade mt-5 text-[13px]/[19px] text-signal">{error}</p> : null}
            </div>
            <div id="pdf-footer" className="flex min-h-[76px] items-center justify-between gap-4 border-t border-hair px-5 py-4" />
          </section>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Shared pieces
 * -----------------------------------------------------------------------------------------------*/

/** Renders into the right column's options area or its footer, which the screen owns. */
function Slot({ to, children }: { to: "pdf-options" | "pdf-footer"; children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setEl(document.getElementById(to)), [to])
  return el ? createPortal(children, el) : null
}

function Footer({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <Slot to="pdf-footer">
      <span className="label min-w-0 truncate text-ink-4">{note}</span>
      {children}
    </Slot>
  )
}

function Empty({ dragging, onChoose }: { dragging: boolean; onChoose: () => void }) {
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden border-t border-hair px-5 pt-6 pb-6 transition-colors duration-300", dragging && "bg-paper-2")}>
      <div className="label flex justify-between text-ink-4">
        <span>PDF · JPEG · PNG · HEIC</span>
        <span>Nothing leaves this computer</span>
      </div>
      <div className="flex flex-col gap-5">
        <p className={cn("display text-[clamp(64px,11vw,180px)] transition-colors duration-300", dragging ? "text-ink" : "text-ghost")}>{dragging ? "Let go" : "Drop PDFs"}</p>
        <div className="flex items-center gap-5 pl-1">
          <button onClick={onChoose} className="focus-ring group flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.01em] text-ink">
            <span className="underline decoration-hair-strong underline-offset-4 transition-colors group-hover:decoration-ink">or choose files</span>
            <ArrowUpRight size={15} strokeWidth={1.5} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </button>
          <span className="label text-ink-4">Pictures can be merged in as pages</span>
        </div>
      </div>
    </div>
  )
}

function FileList({
  items,
  action,
  busy,
  dragging,
  onRemove,
  onClear,
  onMove,
  onAdd,
}: {
  items: Item[]
  action: Action
  busy: boolean
  dragging: boolean
  onRemove: (id: string) => void
  onClear: () => void
  onMove: (from: number, to: number) => void
  onAdd: () => void
}) {
  const { drag, bind } = useReorder(onMove)
  const sortable = action === "merge" && !busy
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto pl-5">
      <div className="label sticky top-0 z-10 flex justify-between bg-paper py-3 pr-5 text-ink-4">
        <span>{action === "merge" ? "In this order" : "Files"}</span>
        {!busy ? (
          <button className="focus-ring transition-colors hover:text-ink" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <ol className="flex flex-col pr-5">
        {items.map((it, i) => {
          const skipped =
            it.problem ||
            (action !== "merge" && it.kind === "image") ||
            (action === "unlock" && !it.locked) ||
            ((action === "split" || action === "protect") && it.locked)
          const why = it.problem
            ? it.problem
            : action !== "merge" && it.kind === "image"
              ? "Pictures are only used by Merge"
              : action === "unlock" && !it.locked
                ? "Has no password"
                : it.locked
                  ? "Locked · unlock it first"
                  : null
          return (
            <li
              key={it.id}
              {...(sortable ? bind(i) : {})}
              className={cn(
                "group anim-rise relative grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-hair py-3.5 transition-opacity",
                sortable && "cursor-grab active:cursor-grabbing",
                drag?.from === i && "opacity-40",
              )}
              style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}
            >
              {drag && drag.over === i && drag.from !== i ? (
                <span className={cn("absolute inset-x-0 h-0.5 bg-ink", drag.from < i ? "-bottom-px" : "-top-px")} />
              ) : null}
              <span className="label text-ink-4 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <div className="flex min-w-0 flex-col gap-1">
                <span className={cn("truncate text-[15px] font-medium tracking-[-0.01em] transition-colors", skipped && "text-ink-4")} title={it.path}>
                  {it.name}
                </span>
                <span className="label flex flex-wrap gap-x-3 text-ink-4">
                  <span>{it.kind === "image" ? "picture · 1 page" : it.locked ? "pdf · locked" : it.pages ? `pdf · ${plural(it.pages, "page")}` : "pdf"}</span>
                  <span>{formatBytes(it.size)}</span>
                  {why ? <span className={cn("normal-case tracking-normal", it.problem && "text-signal")}>{why}</span> : null}
                </span>
              </div>
              <button
                onClick={() => onRemove(it.id)}
                disabled={busy}
                className="focus-ring grid size-6 place-items-center text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink disabled:hidden"
                aria-label={`Remove ${it.name}`}
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-4 py-5">
        <button onClick={onAdd} className="label focus-ring text-ink transition-opacity hover:opacity-60">
          Add files
        </button>
        <span className={cn("label text-ink-4 transition-colors", dragging && "text-ink")}>{dragging ? "Drop to add" : "or drop more anywhere"}</span>
      </div>
    </div>
  )
}

/** For Organise and Sign: which of the PDFs is open. */
function FileTabs({ items, selected, onSelect, onAdd }: { items: Item[]; selected: Item | null; onSelect: (id: string) => void; onAdd: () => void }) {
  return (
    <div className="label flex shrink-0 items-center gap-5 overflow-x-auto px-5 py-3 text-ink-4">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onSelect(it.id)}
          title={it.path}
          className={cn("focus-ring max-w-[28ch] shrink-0 truncate transition-colors hover:text-ink", it.id === selected?.id && "text-ink")}
        >
          {it.name}
        </button>
      ))}
      <button onClick={onAdd} className="focus-ring ml-auto shrink-0 transition-colors hover:text-ink">
        Add
      </button>
    </div>
  )
}

function Locked({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="flex flex-col gap-4 px-5 py-6">
      <p className="display text-[clamp(40px,4.5vw,64px)] text-ghost">This PDF is locked</p>
      <p className="max-w-[44ch] text-[15px]/[22px] text-ink-3">It needs a password to open. Unlock it first, then come back.</p>
      <Button size="lg" variant="solid" className="w-fit" onClick={onUnlock}>
        Unlock it
      </Button>
    </div>
  )
}

type Run = (label: string, fn: () => Promise<void>) => Promise<void>

/* -------------------------------------------------------------------------------------------------
 * Merge
 * -----------------------------------------------------------------------------------------------*/

function MergeOptions({ items, busy, run }: { items: Item[]; busy: boolean; run: Run }) {
  const usable = items.filter((i) => !i.problem && !i.locked)
  const locked = items.filter((i) => i.locked).length
  const [step, setStep] = useState<number | null>(null)
  return (
    <>
      <p className="text-[13px]/[19px] text-ink-3">Pictures become a page each, their own size.</p>
      {locked ? <p className="mt-2 text-[13px]/[19px] text-signal">{plural(locked, "locked PDF")} will be left out. Unlock {locked === 1 ? "it" : "them"} first to include {locked === 1 ? "it" : "them"}.</p> : null}
      <Footer note={busy && step !== null ? `Adding ${step + 1} of ${usable.length}` : "A new file beside the first"}>
        <Button
          size="xl"
          variant="solid"
          disabled={busy || usable.length < 2}
          onClick={() =>
            void run("Merging", async () => {
              const bytes = await merge(
                usable.map((u) => u.path),
                setStep,
              )
              setStep(null)
              const first = usable.find((u) => u.kind === "pdf") ?? usable[0]
              const saved = await fileApi.saveBeside(first.path, " (merged)", "pdf", bytes)
              announceSaved("PDF", [{ path: saved, size: bytes.length }], `${plural(usable.length, "file")} merged`)
            }).finally(() => setStep(null))
          }
        >
          {busy ? "Merging…" : `Merge ${usable.length > 1 ? plural(usable.length, "file") : ""}`}
        </Button>
      </Footer>
    </>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Split
 * -----------------------------------------------------------------------------------------------*/

type SplitMode = "each" | "every" | "ranges"

function SplitOptions({ items, busy, run }: { items: Item[]; busy: boolean; run: Run }) {
  const [mode, setMode] = useState<SplitMode>(() => loadJSON("pdf.split.mode", "each"))
  const [every, setEvery] = useState(() => loadJSON("pdf.split.every", 2))
  const [ranges, setRanges] = useState("")
  const ready = items.filter((i) => i.pages)

  const plan = (it: Item): number[][] =>
    mode === "each" ? chunk(it.pages!, 1) : mode === "every" ? chunk(it.pages!, Math.max(1, every)) : parseRanges(ranges, it.pages!)

  let preview: string | null = null
  let problem: string | null = null
  if (ready.length) {
    try {
      const groups = plan(ready[0])
      const list = `${groups.slice(0, 4).map(rangeLabel).join(", ")}${groups.length > 4 ? "…" : ""}`
      preview = `${ready.length > 1 ? `${ready[0].name} becomes` : "Makes"} ${plural(groups.length, "file")}: ${list}.`
    } catch (e) {
      problem = msg(e)
    }
  }

  return (
    <>
      <div className="divide-y divide-hair border-t border-hair">
        <SettingsRow label="Split into">
          <SettingsSegmented
            size="xs"
            value={mode}
            onValueChange={(v) => {
              setMode(v as SplitMode)
              saveJSON("pdf.split.mode", v)
            }}
            options={[
              { value: "each", label: "Single pages" },
              { value: "every", label: "Every few" },
              { value: "ranges", label: "Ranges" },
            ]}
          />
        </SettingsRow>
        {mode === "every" ? (
          <SettingsRow label="Pages per file">
            <input
              type="number"
              min={1}
              max={999}
              value={every}
              onChange={(e) => {
                const v = Math.max(1, Math.min(999, Number(e.target.value) || 1))
                setEvery(v)
                saveJSON("pdf.split.every", v)
              }}
              className="chatcn-focus h-7 w-20 rounded-md bg-paper-2 px-2.5 text-right text-[13px] font-medium text-ink tabular-nums outline-none"
              aria-label="Pages per file"
            />
          </SettingsRow>
        ) : null}
        {mode === "ranges" ? (
          <SettingsRow label="Pages" description="One file per range. Commas separate files." stacked>
            <input
              value={ranges}
              onChange={(e) => setRanges(e.target.value)}
              placeholder="1-3, 5, 8-"
              spellCheck={false}
              className="chatcn-focus h-10 w-full rounded-lg bg-paper-2 px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
          </SettingsRow>
        ) : null}
      </div>
      {problem ? <p className="mt-4 text-[13px]/[19px] text-signal">{problem}</p> : preview ? <p className="mt-4 text-[13px]/[19px] text-ink-3">{preview}</p> : null}
      <Footer note="A new folder beside each PDF">
        <Button
          size="xl"
          variant="solid"
          disabled={busy || !ready.length || !!problem}
          onClick={() =>
            void run("Splitting", async () => {
              const saved: { path: string }[] = []
              let files = 0
              for (const it of ready) {
                const groups = plan(it)
                const folder = await folderBeside(it.path, " (split)")
                const fake = `${folder}${sepOf(it.path)}${stemOf(it.path)}.pdf`
                for (const g of groups) {
                  const bytes = await pick(
                    it.path,
                    g.map((page) => ({ page })),
                  )
                  await fileApi.saveBeside(fake, ` (${rangeLabel(g)})`, "pdf", bytes)
                  files++
                }
                saved.push({ path: folder })
              }
              announceSaved("PDF", saved, `${plural(files, "file")} made`)
            })
          }
        >
          {busy ? "Splitting…" : ready.length > 1 ? `Split ${plural(ready.length, "PDF")}` : "Split"}
        </Button>
      </Footer>
    </>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Protect / Unlock
 * -----------------------------------------------------------------------------------------------*/

function PasswordBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative flex w-full">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="new-password"
        className="chatcn-focus h-10 w-full rounded-lg bg-paper-2 pr-10 pl-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="focus-ring absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-4 hover:text-ink"
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
      </button>
    </span>
  )
}

function ProtectOptions({ items, busy, run }: { items: Item[]; busy: boolean; run: Run }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [allowPrint, setAllowPrint] = useState(true)
  const [allowCopy, setAllowCopy] = useState(false)
  const [allowEdit, setAllowEdit] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <>
      <div className="divide-y divide-hair border-t border-hair">
        <SettingsRow label="Password" description="Needed to open the file. Morf can't recover it if it's forgotten." stacked>
          <div className="flex w-full flex-col gap-2">
            <PasswordBox value={password} onChange={setPassword} placeholder="Password" />
            <PasswordBox value={confirm} onChange={setConfirm} placeholder="Type it again" />
            {mismatch ? <span className="text-[12px] text-signal">The two don't match yet.</span> : null}
          </div>
        </SettingsRow>
        <SettingsRow label="Allow printing">
          <SettingsSwitch checked={allowPrint} onCheckedChange={setAllowPrint} />
        </SettingsRow>
        <SettingsRow label="Allow copying text">
          <SettingsSwitch checked={allowCopy} onCheckedChange={setAllowCopy} />
        </SettingsRow>
        <SettingsRow label="Allow editing" description="Comments, form filling and changing pages.">
          <SettingsSwitch checked={allowEdit} onCheckedChange={setAllowEdit} />
        </SettingsRow>
      </div>
      <Footer note="Copies · originals kept">
        <Button
          size="xl"
          variant="solid"
          disabled={busy || !items.length || !password || password !== confirm}
          onClick={() =>
            void run("Protecting", async () => {
              const saved = []
              for (const it of items) saved.push({ path: await pdfPasswords.protect({ path: it.path, password, allowPrint, allowCopy, allowEdit }) })
              announceSaved("PDF", saved, "Protected with a password")
              setPassword("")
              setConfirm("")
            })
          }
        >
          {busy ? "Protecting…" : `Protect${items.length > 1 ? ` ${plural(items.length, "file")}` : ""}`}
        </Button>
      </Footer>
    </>
  )
}

function UnlockOptions({ items, busy, run, onDone }: { items: Item[]; busy: boolean; run: Run; onDone: (ids: string[]) => void }) {
  const [password, setPassword] = useState("")
  return (
    <>
      <div className="divide-y divide-hair border-t border-hair">
        <SettingsRow label="Password" description="The one that opens the file. Only for files you're allowed to open." stacked>
          <PasswordBox value={password} onChange={setPassword} placeholder="Password" />
        </SettingsRow>
      </div>
      {!items.length ? <p className="mt-4 text-[13px]/[19px] text-ink-3">None of these files has a password.</p> : null}
      <Footer note="Copies · originals kept">
        <Button
          size="xl"
          variant="solid"
          disabled={busy || !items.length || !password}
          onClick={() =>
            void run("Unlocking", async () => {
              const saved = []
              for (const it of items) saved.push({ path: await pdfPasswords.unlock(it.path, password) })
              announceSaved("PDF", saved, "Password removed")
              setPassword("")
              onDone(items.map((i) => i.id))
            })
          }
        >
          {busy ? "Unlocking…" : `Unlock${items.length > 1 ? ` ${plural(items.length, "file")}` : ""}`}
        </Button>
      </Footer>
    </>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Organise
 * -----------------------------------------------------------------------------------------------*/

interface PageRef {
  key: string
  page: number
  turn: number
}

function Thumb({ path, page, turn, width }: { path: string; page: number; turn: number; width: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Draw only when scrolled near, so a 300-page PDF doesn't render everything at once.
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return
        io.disconnect()
        void pageImage(path, page, width).then((u) => !cancelled && setUrl(u))
      },
      { rootMargin: "400px" },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [path, page, width])
  return (
    // A square box: a page of any shape, turned any way, always fits inside it.
    <div ref={ref} className="relative aspect-square w-full">
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="anim-fade absolute inset-0 m-auto max-h-full max-w-full rounded-[3px] bg-white shadow-[0_0_0_1px_var(--hair),0_2px_8px_-4px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-out"
          style={{ transform: `rotate(${turn}deg)` }}
        />
      ) : (
        <span className="absolute inset-y-0 left-1/2 aspect-[1/1.414] -translate-x-1/2 rounded-[3px] bg-paper-2" />
      )}
    </div>
  )
}

function Organise({ item, busy, run }: { item: Item; busy: boolean; run: Run }) {
  const initial = useMemo<PageRef[]>(() => Array.from({ length: item.pages ?? 0 }, (_, i) => ({ key: `k${i}`, page: i + 1, turn: 0 })), [item.pages])
  const [pages, setPages] = useState<PageRef[]>(initial)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const anchor = useRef<number | null>(null)
  useEffect(() => setPages(initial), [initial])

  const { drag, bind } = useReorder((from, to) => setPages((p) => move(p, from, to)))
  const changed = pages.length !== initial.length || pages.some((p, i) => p.page !== i + 1 || p.turn % 360 !== 0)
  const targets = sel.size ? pages.filter((p) => sel.has(p.key)) : pages
  const turn = (by: number) => setPages((ps) => ps.map((p) => (targets.includes(p) ? { ...p, turn: p.turn + by } : p)))
  const removeSel = () => {
    if (!sel.size) return
    setPages((ps) => ps.filter((p) => !sel.has(p.key)))
    setSel(new Set())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) {
        e.preventDefault()
        removeSel()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault()
        setSel(new Set(pages.map((p) => p.key)))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const click = (i: number, e: React.MouseEvent) => {
    const key = pages[i].key
    setSel((s) => {
      const next = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? s : [])
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = [anchor.current, i].sort((x, y) => x - y)
        for (let k = a; k <= b; k++) next.add(pages[k].key)
      } else if (s.has(key) && (e.ctrlKey || e.metaKey)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!e.shiftKey) anchor.current = i
  }

  if (!item.pages) return <p className="label px-5 py-6 text-ink-4">Reading pages…</p>

  return (
    <>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-6" onClick={(e) => e.target === e.currentTarget && setSel(new Set())}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-4 gap-y-5 pt-1">
          {pages.map((p, i) => (
            <div
              key={p.key}
              {...bind(i)}
              onClick={(e) => click(i, e)}
              className={cn(
                "group relative flex cursor-grab touch-none flex-col items-center gap-2 rounded-xl p-2 transition-[background-color,opacity] active:cursor-grabbing",
                sel.has(p.key) ? "bg-paper-3" : "hover:bg-paper-2",
                drag?.from === i && "opacity-30",
              )}
            >
              {drag && drag.over === i && drag.from !== i ? (
                <span className={cn("absolute inset-y-2 w-0.5 rounded-full bg-ink", drag.from < i ? "-right-2.5" : "-left-2.5")} />
              ) : null}
              <Thumb path={item.path} page={p.page} turn={p.turn} width={118} />
              <span className={cn("label tabular-nums", sel.has(p.key) ? "text-ink" : "text-ink-4")}>
                {String(i + 1).padStart(2, "0")}
                {p.page !== i + 1 ? <span className="text-ink-4"> · was {p.page}</span> : null}
              </span>
              <span className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setPages((ps) => ps.map((x) => (x.key === p.key ? { ...x, turn: x.turn + 90 } : x)))
                  }}
                  className="focus-ring grid size-6 place-items-center rounded-md bg-card text-ink-2 shadow-float hover:text-ink"
                  aria-label={`Turn page ${i + 1}`}
                >
                  <RotateCw size={12} strokeWidth={1.75} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setPages((ps) => ps.filter((x) => x.key !== p.key))
                    setSel((s) => {
                      const n = new Set(s)
                      n.delete(p.key)
                      return n
                    })
                  }}
                  className="focus-ring grid size-6 place-items-center rounded-md bg-card text-ink-2 shadow-float hover:text-signal"
                  aria-label={`Remove page ${i + 1}`}
                >
                  <X size={12} strokeWidth={1.75} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <Slot to="pdf-options">
        <div className="divide-y divide-hair border-t border-hair">
          <SettingsRow label={sel.size ? `${plural(sel.size, "page")} selected` : "All pages"} description={sel.size ? "Shift-click for a run, Ctrl-click to add one." : "Click pages to act on just those."}>
            <div className="flex gap-1">
              <Button size="icon-md" variant="subtle" onClick={() => turn(-90)} aria-label="Turn left" title="Turn left">
                <RotateCcw />
              </Button>
              <Button size="icon-md" variant="subtle" onClick={() => turn(90)} aria-label="Turn right" title="Turn right">
                <RotateCw />
              </Button>
              <Button size="icon-md" variant="subtle" disabled={!sel.size} onClick={removeSel} aria-label="Remove selected" title="Remove selected">
                <Trash2 />
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label="Start over" description="Puts every page back as it was.">
            <Button
              size="sm"
              variant="subtle"
              disabled={!changed}
              onClick={() => {
                setPages(initial)
                setSel(new Set())
              }}
            >
              Reset
            </Button>
          </SettingsRow>
        </div>
      </Slot>

      <Footer note={`${plural(pages.length, "page")} · a copy, original kept`}>
        <Button
          size="xl"
          variant="solid"
          disabled={busy || !changed || !pages.length}
          onClick={() =>
            void run("Saving", async () => {
              const bytes = await pick(
                item.path,
                pages.map((p) => ({ page: p.page, turn: p.turn })),
              )
              const saved = await fileApi.saveBeside(item.path, " (organised)", "pdf", bytes)
              announceSaved("PDF", [{ path: saved, size: bytes.length }], plural(pages.length, "page"))
            })
          }
        >
          {busy ? "Saving…" : "Save PDF"}
        </Button>
      </Footer>
    </>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Sign
 * -----------------------------------------------------------------------------------------------*/

interface Placed {
  id: string
  page: number
  x: number
  y: number
  /** Width as a fraction of the page; height follows the signature's shape. */
  w: number
}

function Sign({ item, busy, run }: { item: Item; busy: boolean; run: Run }) {
  const [page, setPage] = useState(1)
  const [aspects, setAspects] = useState<Record<number, number>>({})
  const [placed, setPlaced] = useState<Placed[]>([])
  const [remembered, setRemembered] = useState<string | null>(() => loadJSON<string | null>("pdf.signature", null))
  const [mode, setMode] = useState<"saved" | "draw" | "type">(remembered ? "saved" : "draw")
  const [ink, setInk] = useState<Ink>(() => loadJSON("pdf.ink", "black"))
  const [drawn, setDrawn] = useState<string | null>(null)
  const [clear, setClear] = useState(0)
  const [remember, setRemember] = useState(() => loadJSON("pdf.remember", false))
  const [sigAspect, setSigAspect] = useState(3)
  const signature = mode === "saved" ? remembered : drawn
  const pages = item.pages ?? 0

  useEffect(() => {
    if (!signature) return
    const img = new Image()
    img.onload = () => setSigAspect(img.naturalWidth / Math.max(1, img.naturalHeight))
    img.src = signature
  }, [signature])

  useEffect(() => {
    if (!pages || aspects[page]) return
    void pageAspect(item.path, page).then((a) => setAspects((m) => ({ ...m, [page]: a })))
  }, [item.path, page, pages, aspects])

  // Fit the page into the space available.
  const box = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const aspect = aspects[page] ?? 1 / 1.414
  const pw = Math.max(1, Math.min(avail.w, avail.h * aspect))
  const ph = pw / aspect
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!pw || pw < 10) return
    let cancelled = false
    setUrl(null)
    // Render at a few fixed widths so resizing the window doesn't redraw on every pixel.
    const w = Math.min(1600, Math.ceil(pw / 200) * 200)
    void pageImage(item.path, page, w).then((u) => !cancelled && setUrl(u))
    return () => {
      cancelled = true
    }
  }, [item.path, page, pw])

  const hFrac = (pl: Placed) => (pl.w * (aspects[pl.page] ?? aspect)) / sigAspect

  const place = () => {
    if (!signature) return
    const w = 0.28
    const h = (w * aspect) / sigAspect
    // Lower right, where signatures usually go; then drag it into place.
    setPlaced((p) => [...p, { id: newId(), page, w, x: 1 - w - 0.1, y: Math.max(0, 0.88 - h) }])
  }

  // Dragging and resizing placed signatures.
  const gesture = useRef<{ id: string; kind: "move" | "size"; sx: number; sy: number; ox: number; oy: number; ow: number } | null>(null)
  const onDown = (e: React.PointerEvent, pl: Placed, kind: "move" | "size") => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { id: pl.id, kind, sx: e.clientX, sy: e.clientY, ox: pl.x, oy: pl.y, ow: pl.w }
  }
  const onMoveG = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const dx = (e.clientX - g.sx) / pw
    const dy = (e.clientY - g.sy) / ph
    setPlaced((ps) =>
      ps.map((p) => {
        if (p.id !== g.id) return p
        if (g.kind === "move") {
          const h = hFrac(p)
          return { ...p, x: Math.min(1 - p.w, Math.max(0, g.ox + dx)), y: Math.min(1 - h, Math.max(0, g.oy + dy)) }
        }
        const w = Math.min(1 - p.x, Math.max(0.06, g.ow + dx))
        return { ...p, w }
      }),
    )
  }
  const onUp = () => (gesture.current = null)

  const here = placed.filter((p) => p.page === page)

  return (
    <>
      <div className="label flex shrink-0 items-center justify-between px-5 pb-3 text-ink-4">
        <span className="flex items-center gap-2">
          <button className="focus-ring grid size-6 place-items-center rounded-md hover:bg-paper-2 hover:text-ink disabled:opacity-30" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            Page <span className="text-ink">{page}</span> of {pages}
          </span>
          <button className="focus-ring grid size-6 place-items-center rounded-md hover:bg-paper-2 hover:text-ink disabled:opacity-30" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight size={14} />
          </button>
        </span>
        <span>{placed.length ? plural(placed.length, "signature") : "Drag to place · corner to resize"}</span>
      </div>
      <div ref={box} className="relative mx-5 mb-5 min-h-0 flex-1">
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 overflow-hidden rounded-[3px] bg-white shadow-[0_0_0_1px_var(--hair),0_12px_32px_-16px_rgba(0,0,0,0.35)]"
          style={{ width: pw, height: ph }}
          onPointerMove={onMoveG}
          onPointerUp={onUp}
        >
          {url ? <img src={url} alt="" draggable={false} className="anim-fade absolute inset-0 h-full w-full" /> : null}
          {signature
            ? here.map((pl) => (
                <div
                  key={pl.id}
                  onPointerDown={(e) => onDown(e, pl, "move")}
                  className="group absolute cursor-move touch-none outline-1 outline-transparent outline-dashed hover:outline-[#141414]/50"
                  style={{ left: `${pl.x * 100}%`, top: `${pl.y * 100}%`, width: `${pl.w * 100}%`, height: `${hFrac(pl) * 100}%` }}
                >
                  <img src={signature} alt="" draggable={false} className="h-full w-full" />
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setPlaced((ps) => ps.filter((p) => p.id !== pl.id))}
                    className="absolute -top-2.5 -right-2.5 grid size-5 place-items-center rounded-full bg-[#141414] text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove this signature"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                  <span
                    onPointerDown={(e) => onDown(e, pl, "size")}
                    className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-full border border-white bg-[#141414] opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ))
            : null}
        </div>
      </div>

      <Slot to="pdf-options">
        <div className="flex flex-col gap-3 border-t border-hair pt-4">
          <div className="flex items-center justify-between gap-3">
            <SettingsSegmented
              size="xs"
              value={mode}
              onValueChange={(v) => setMode(v as typeof mode)}
              options={[...(remembered ? [{ value: "saved", label: "Saved" }] : []), { value: "draw", label: "Draw" }, { value: "type", label: "Type" }]}
            />
            <span className="flex items-center gap-1.5">
              {(Object.keys(INKS) as Ink[]).map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setInk(k)
                    saveJSON("pdf.ink", k)
                  }}
                  className={cn(
                    "focus-ring size-5 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)] ring-offset-2 ring-offset-paper transition-shadow",
                    ink === k ? "ring-2 ring-ink" : "ring-1 ring-hair-strong",
                  )}
                  style={{ background: INKS[k] }}
                  aria-label={`${k} ink`}
                />
              ))}
            </span>
          </div>
          {mode === "saved" && remembered ? (
            <div className="relative grid h-40 place-items-center rounded-xl bg-[#fbfaf7] px-6 ring-1 ring-hair">
              <img src={remembered} alt="Your saved signature" className="max-h-28 max-w-full" />
              <button
                onClick={() => {
                  setRemembered(null)
                  saveJSON("pdf.signature", null)
                  setMode("draw")
                }}
                className="label absolute right-3 bottom-2.5 text-[#8a8983] transition-colors hover:text-[#141414]"
              >
                Forget
              </button>
            </div>
          ) : mode === "draw" ? (
            <DrawPad ink={ink} onChange={setDrawn} clearSignal={clear} />
          ) : (
            <TypePad ink={ink} onChange={setDrawn} />
          )}
          <div className="flex items-center justify-between">
            {mode === "draw" ? (
              <button className="label focus-ring text-ink-4 transition-colors hover:text-ink" onClick={() => setClear((c) => c + 1)}>
                Clear
              </button>
            ) : (
              <span />
            )}
            <Button size="md" variant="subtle" disabled={!signature} onClick={place}>
              Place on page {page}
            </Button>
          </div>
        </div>
        <div className="mt-4 divide-y divide-hair border-t border-hair">
          <SettingsRow label="Remember my signature" description="Kept on this computer only, for next time.">
            <SettingsSwitch
              checked={remember}
              onCheckedChange={(v) => {
                setRemember(v)
                saveJSON("pdf.remember", v)
                if (!v) {
                  saveJSON("pdf.signature", null)
                  setRemembered(null)
                  if (mode === "saved") setMode("draw")
                }
              }}
            />
          </SettingsRow>
        </div>
        <p className="mt-3 text-[12px]/[17px] text-ink-4">This adds your signature as a picture. It isn't a certified digital signature.</p>
      </Slot>

      <Footer note={placed.length ? `${plural(placed.length, "signature")} placed` : "Place your signature first"}>
        <Button
          size="xl"
          variant="solid"
          disabled={busy || !placed.length || !signature}
          onClick={() =>
            void run("Signing", async () => {
              const sig = signature!
              const pls: Placement[] = placed.map((p) => ({ page: p.page, x: p.x, y: p.y, w: p.w, h: hFrac(p) }))
              const bytes = await sign(item.path, dataUrlBytes(sig), pls)
              const saved = await fileApi.saveBeside(item.path, " (signed)", "pdf", bytes)
              if (remember && mode !== "saved") {
                saveJSON("pdf.signature", sig)
                setRemembered(sig)
              }
              announceSaved("PDF", [{ path: saved, size: bytes.length }], plural(placed.length, "signature"))
              setPlaced([])
            })
          }
        >
          {busy ? "Signing…" : "Save signed PDF"}
        </Button>
      </Footer>
    </>
  )
}
