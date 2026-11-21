import { useEffect, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import {
  Cpu,
  Download,
  FolderOutput,
  HardDrive,
  Info,
  Keyboard,
  Monitor,
  Moon,
  PenLine,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react"
import {
  SettingsGroup,
  SettingsNav,
  SettingsNavItem,
  SettingsPane,
  SettingsPanel,
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
} from "@/components/ui/settings-panel"
import { Button } from "@/components/ui/button"
import { Wordmark } from "@/components/Logo"
import { dictation, engineStatus, inTauri, pickFolder, reveal, setShellMenu, type EngineStatus } from "@/lib/engine"
import { resetPrefs, saveJSON, setPref, usePrefs } from "@/lib/prefs"
import { TOOLS } from "@/lib/tools"
import { appVersion, checkForUpdate, installUpdate, lastChecked, useUpdate } from "@/lib/updater"
import { basename, cn, formatBytes, modKey } from "@/lib/utils"
import { invoke } from "@tauri-apps/api/core"

export type SettingsSection = "general" | "output" | "updates" | "storage" | "privacy" | "engine" | "writing" | "shortcuts" | "about"

interface Storage {
  models: { id: string; name: string; kind: "speech" | "cutout"; size: number }[]
  previews: number
  dataDir: string
}

const storageInfo = (): Promise<Storage> =>
  inTauri
    ? invoke("storage_info")
    : Promise.resolve({
        models: [
          { id: "parakeet-tdt-0.6b-v3", name: "Parakeet V3", kind: "speech", size: 739_508_576 },
          { id: "cutout", name: "Cutout (ISNet)", kind: "cutout", size: 178_648_008 },
        ],
        previews: 12_400_000,
        dataDir: "C:\\Users\\you\\AppData\\Roaming\\dev.morf.desktop",
      })

/** A button that asks once more before doing something you can't take back. */
function ConfirmButton({ children, confirm = "Sure?", onConfirm, disabled }: { children: React.ReactNode; confirm?: string; onConfirm: () => void | Promise<void>; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <Button
      size="sm"
      variant="subtle"
      disabled={disabled}
      className={cn("min-w-[76px]", armed && "bg-signal text-white hover:bg-signal")}
      onClick={async () => {
        if (!armed) return setArmed(true)
        setArmed(false)
        await onConfirm()
      }}
    >
      {armed ? `${confirm}?` : children}
    </Button>
  )
}

function Done({ children }: { children: React.ReactNode }) {
  return <span className="label anim-fade px-2 text-ink-4">{children}</span>
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-md border border-hair-strong bg-paper px-1.5 py-0.5 font-mono text-[11px] leading-4 tracking-normal text-ink-2">{children}</kbd>
}

export function SettingsDialog({
  open,
  onOpenChange,
  section,
  onSectionChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  section: SettingsSection
  onSectionChange: (s: SettingsSection) => void
}) {
  const prefs = usePrefs()
  const update = useUpdate()
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [version, setVersion] = useState("")
  const [storage, setStorage] = useState<Storage | null>(null)
  const [autostart, setAutostart] = useState<boolean | null>(null)
  const [cleared, setCleared] = useState<Record<string, boolean>>({})
  const [shortcut, setShortcut] = useState<string | null>(null)

  const refreshStorage = () => void storageInfo().then(setStorage).catch(() => setStorage(null))

  useEffect(() => {
    if (!open) return
    setCleared({})
    void engineStatus().then(setStatus).catch(() => setStatus(null))
    void appVersion().then(setVersion)
    refreshStorage()
    void dictation.settings().then((s) => setShortcut(s.enabled ? s.shortcut : null))
    if (inTauri)
      void import("@tauri-apps/plugin-autostart")
        .then((m) => m.isEnabled())
        .then(setAutostart)
        .catch(() => setAutostart(null))
  }, [open])

  const mark = (key: string) => setCleared((c) => ({ ...c, [key]: true }))
  const checked = lastChecked()
  const updating = update.kind === "available" || update.kind === "downloading" || update.kind === "installing"

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-paper/60 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "on-card fixed top-1/2 left-1/2 z-50 w-[min(920px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-card shadow-float outline-none",
            "transition-[opacity,scale] duration-200 ease-out-quint data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
          )}
        >
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Dialog.Close
            className="focus-ring absolute top-3.5 right-3.5 z-10 grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink"
            aria-label="Close settings"
          >
            <X size={16} strokeWidth={1.5} />
          </Dialog.Close>

          <SettingsPanel value={section} onValueChange={(v) => onSectionChange(v as SettingsSection)} className="h-[min(640px,calc(100vh-80px))]">
            <SettingsNav
              title="Settings"
              footer={
                <div className="label px-2 text-ink-4">
                  Morf {version}
                  <br />
                  Runs on this computer
                </div>
              }
            >
              <SettingsNavItem value="general" icon={<SlidersHorizontal />}>
                General
              </SettingsNavItem>
              <SettingsNavItem value="output" icon={<FolderOutput />}>
                Output
              </SettingsNavItem>
              <SettingsNavItem value="updates" icon={<Download />} meta={updating ? <span className="text-signal">New</span> : undefined}>
                Updates
              </SettingsNavItem>
              <SettingsNavItem
                value="storage"
                icon={<HardDrive />}
                meta={storage ? formatBytes(storage.models.reduce((n, m) => n + m.size, 0) + storage.previews, 0) : undefined}
              >
                Storage
              </SettingsNavItem>
              <SettingsNavItem value="privacy" icon={<ShieldCheck />}>
                Privacy
              </SettingsNavItem>
              <SettingsNavItem value="engine" icon={<Cpu />} meta={status?.ffmpeg ? "Ready" : status ? "Missing" : undefined}>
                Engine
              </SettingsNavItem>
              <SettingsNavItem value="writing" icon={<PenLine />}>
                Writing
              </SettingsNavItem>
              <SettingsNavItem value="shortcuts" icon={<Keyboard />}>
                Shortcuts
              </SettingsNavItem>
              <SettingsNavItem value="about" icon={<Info />}>
                About
              </SettingsNavItem>
            </SettingsNav>

            {/* General */}
            <SettingsPane value="general" title="General">
              <SettingsGroup title="Appearance">
                <SettingsRow label="Theme" description="System follows your computer.">
                  <SettingsSegmented
                    value={prefs.theme}
                    onValueChange={(v) => setPref("theme", v as typeof prefs.theme)}
                    options={[
                      { value: "light", label: "Light", icon: <Sun />, iconOnly: true },
                      { value: "dark", label: "Dark", icon: <Moon />, iconOnly: true },
                      { value: "system", label: "System", icon: <Monitor />, iconOnly: true },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow label="Index layout" description="How the tools are shown on the first screen.">
                  <SettingsSegmented
                    value={prefs.indexView}
                    onValueChange={(v) => setPref("indexView", v as typeof prefs.indexView)}
                    options={[
                      { value: "list", label: "List" },
                      { value: "grid", label: "Grid" },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow label="Reduce motion" description="Shortens transitions and turns off entrance animations.">
                  <SettingsSwitch checked={prefs.reduceMotion} onCheckedChange={(v) => setPref("reduceMotion", v)} />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Starting up">
                <SettingsRow label="Open on" description="What you see when Morf opens.">
                  <SettingsSegmented
                    value={prefs.startOn}
                    onValueChange={(v) => setPref("startOn", v as typeof prefs.startOn)}
                    options={[
                      { value: "index", label: "Index" },
                      { value: "last", label: "Last tool" },
                    ]}
                  />
                </SettingsRow>
                {inTauri ? (
                  <SettingsRow label="Open at sign-in" description="Starts quietly in the tray, so dictation is ready straight away.">
                    <SettingsSwitch
                      checked={!!autostart}
                      disabled={autostart === null}
                      onCheckedChange={async (v) => {
                        const m = await import("@tauri-apps/plugin-autostart")
                        await (v ? m.enable() : m.disable()).catch(() => {})
                        setAutostart(await m.isEnabled().catch(() => !v))
                      }}
                    />
                  </SettingsRow>
                ) : null}
              </SettingsGroup>
              <SettingsGroup title="When a job finishes">
                <SettingsRow label="Show a notification" description="Only while Morf is in the background.">
                  <SettingsSwitch checked={prefs.notifyWhenDone} onCheckedChange={(v) => setPref("notifyWhenDone", v)} />
                </SettingsRow>
                <SettingsRow label="Reveal the results" description="Opens the folder with the first new file selected.">
                  <SettingsSwitch checked={prefs.revealWhenDone} onCheckedChange={(v) => setPref("revealWhenDone", v)} />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* Output */}
            <SettingsPane value="output" title="Output" description="Morf never overwrites a file. If a name is taken, the new file gets a number: photo 2.jpg.">
              <SettingsGroup title="Where new files go">
                <SettingsRow label="Location" description="For Convert, Compress and Resize. A read-only folder always falls back to Downloads.">
                  <SettingsSegmented
                    value={prefs.outputMode}
                    onValueChange={(v) => setPref("outputMode", v as typeof prefs.outputMode)}
                    options={[
                      { value: "beside", label: "Next to original" },
                      { value: "folder", label: "One folder" },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow label="Folder" description={prefs.outputFolder ?? "None chosen yet"} disabled={prefs.outputMode !== "folder"}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={prefs.outputMode !== "folder"}
                    onClick={async () => {
                      const f = await pickFolder()
                      if (f) setPref("outputFolder", f)
                    }}
                  >
                    {prefs.outputFolder ? `Change (${basename(prefs.outputFolder)})` : "Choose…"}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
              {status?.platform === "windows" ? (
                <SettingsGroup title="Right-click menu">
                  <SettingsRow
                    label="Add Morf to the right-click menu"
                    description="Convert with Morf and Compress with Morf, on any file in Explorer. On Windows 11 they're under Show more options."
                  >
                    <SettingsSwitch
                      checked={status.shellMenu}
                      onCheckedChange={async (v) => {
                        const on = await setShellMenu(v).catch(() => !v)
                        setStatus((s) => (s ? { ...s, shellMenu: on } : s))
                      }}
                    />
                  </SettingsRow>
                </SettingsGroup>
              ) : null}
              <SettingsGroup title="Originals">
                <SettingsRow label="Move originals to the Trash" description="Only after the new file exists. You can put them back from the Trash or Recycle Bin.">
                  <SettingsSwitch checked={prefs.trashOriginals} onCheckedChange={(v) => setPref("trashOriginals", v)} />
                </SettingsRow>
                <SettingsRow label="Remember format settings" description="Keep what you choose under Advanced for each format.">
                  <SettingsSwitch checked={prefs.rememberFormatSettings} onCheckedChange={(v) => setPref("rememberFormatSettings", v)} />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* Updates */}
            <SettingsPane
              value="updates"
              title="Updates"
              description="New versions come from Morf's releases on GitHub. Each one is checked against Morf's signature before it installs."
            >
              <SettingsGroup>
                <SettingsRow
                  label={`Morf ${version}`}
                  description={
                    update.kind === "checking"
                      ? "Looking for a new version…"
                      : update.kind === "current"
                        ? "You have the latest version."
                        : update.kind === "error"
                          ? update.message
                          : updating
                            ? `Morf ${update.version} is ready to install.`
                            : checked
                              ? `Last checked ${new Date(checked).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`
                              : "Not checked yet."
                  }
                >
                  <Button size="sm" variant="outline" disabled={update.kind === "checking" || update.kind === "downloading" || update.kind === "installing"} onClick={() => void checkForUpdate()}>
                    {update.kind === "checking" ? "Checking…" : "Check now"}
                  </Button>
                </SettingsRow>
                <SettingsRow label="Check automatically" description="When Morf opens, at most every few hours. Nothing installs until you say so.">
                  <SettingsSwitch checked={prefs.autoUpdate} onCheckedChange={(v) => setPref("autoUpdate", v)} />
                </SettingsRow>
              </SettingsGroup>
              {updating ? (
                <SettingsGroup title={`What's new in ${update.version}`}>
                  <div className="flex flex-col gap-4 py-3">
                    {update.kind === "available" && update.notes ? (
                      <p className="scroll-quiet max-h-48 overflow-y-auto text-[13px]/[20px] whitespace-pre-line text-ink-2">{update.notes}</p>
                    ) : null}
                    {update.kind === "downloading" ? (
                      <div className="flex flex-col gap-2">
                        <div className="relative h-px bg-hair">
                          <div
                            className="absolute inset-y-0 left-0 bg-ink transition-[width]"
                            style={{ width: update.total ? `${Math.min(100, (update.received / update.total) * 100)}%` : "30%" }}
                          />
                        </div>
                        <span className="label text-ink-4 tabular-nums">
                          {formatBytes(update.received)}
                          {update.total ? ` of ${formatBytes(update.total)}` : ""}
                        </span>
                      </div>
                    ) : null}
                    <Button size="lg" variant="solid" className="w-fit" disabled={update.kind !== "available"} onClick={() => void installUpdate()}>
                      {update.kind === "installing" ? "Restarting…" : update.kind === "downloading" ? "Downloading…" : "Install and restart"}
                    </Button>
                  </div>
                </SettingsGroup>
              ) : null}
            </SettingsPane>

            {/* Models & storage */}
            <SettingsPane
              value="storage"
              title="Models and storage"
              description="Large models download once, when a tool first needs them. Delete one to free the space; it downloads again next time it's needed."
            >
              <SettingsGroup title="Downloaded models">
                {storage?.models.length ? (
                  storage.models.map((m) => (
                    <SettingsRow key={m.id} label={m.name} description={`${m.kind === "speech" ? "Dictate" : "Cutout"} · ${formatBytes(m.size)}`}>
                      <ConfirmButton
                        confirm="Delete"
                        onConfirm={async () => {
                          if (m.kind === "speech") await dictation.remove(m.id).catch(() => {})
                          else if (inTauri) await invoke("delete_cutout_model").catch(() => {})
                          refreshStorage()
                        }}
                      >
                        Delete
                      </ConfirmButton>
                    </SettingsRow>
                  ))
                ) : (
                  <SettingsRow label="None yet" description="Dictate and Cutout download their models the first time you use them." />
                )}
              </SettingsGroup>
              <SettingsGroup title="Other files">
                <SettingsRow label="Read languages" description="Languages other than English that Read downloaded. They download again when needed.">
                  {cleared.ocr ? (
                    <Done>Removed</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Remove"
                      onConfirm={async () => {
                        await new Promise<void>((r) => {
                          const req = indexedDB.deleteDatabase("keyval-store")
                          req.onsuccess = req.onerror = req.onblocked = () => r()
                        })
                        mark("ocr")
                      }}
                    >
                      Remove
                    </ConfirmButton>
                  )}
                </SettingsRow>
                <SettingsRow label="Picture previews" description={`Copies of HEIC, TIFF and RAW pictures, made to show them${storage ? ` · ${formatBytes(storage.previews)}` : ""}.`}>
                  <Button
                    size="sm"
                    variant="subtle"
                    className="min-w-[76px]"
                    disabled={!storage?.previews}
                    onClick={async () => {
                      if (inTauri) await invoke("clear_previews").catch(() => {})
                      refreshStorage()
                    }}
                  >
                    Clear
                  </Button>
                </SettingsRow>
                {inTauri && storage ? (
                  <SettingsRow label="Morf's folder" description={storage.dataDir}>
                    <Button size="sm" variant="outline" className="min-w-[76px]" onClick={() => void reveal(storage.dataDir)}>
                      Show
                    </Button>
                  </SettingsRow>
                ) : null}
              </SettingsGroup>
            </SettingsPane>

            {/* Privacy */}
            <SettingsPane value="privacy" title="Privacy" description="Morf has no accounts and no analytics, and sends nothing anywhere. These are the few things it remembers on this computer.">
              <SettingsGroup title="Remembered">
                <SettingsRow label="Dictation history" description="Your recent dictations, kept so you can copy them again.">
                  {cleared.dictation ? (
                    <Done>Cleared</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Clear"
                      onConfirm={async () => {
                        await dictation.clearHistory()
                        mark("dictation")
                      }}
                    >
                      Clear
                    </ConfirmButton>
                  )}
                </SettingsRow>
                <SettingsRow label="Saved signature" description="Kept when you turn on Remember my signature in PDF.">
                  {cleared.signature ? (
                    <Done>Forgotten</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Forget"
                      onConfirm={() => {
                        saveJSON("pdf.signature", null)
                        saveJSON("pdf.remember", false)
                        mark("signature")
                      }}
                    >
                      Forget
                    </ConfirmButton>
                  )}
                </SettingsRow>
                <SettingsRow label="Picked colours" description="Palette's list of colours picked before.">
                  {cleared.palette ? (
                    <Done>Cleared</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Clear"
                      onConfirm={() => {
                        saveJSON("palette.history", [])
                        mark("palette")
                      }}
                    >
                      Clear
                    </ConfirmButton>
                  )}
                </SettingsRow>
                <SettingsRow label="Text drafts" description="What you last typed in Count and Compare.">
                  {cleared.drafts ? (
                    <Done>Cleared</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Clear"
                      onConfirm={() => {
                        for (const k of ["count.draft", "compare.a", "compare.b"]) saveJSON(k, "")
                        mark("drafts")
                      }}
                    >
                      Clear
                    </ConfirmButton>
                  )}
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Start fresh">
                <SettingsRow label="Reset all settings" description="Puts every setting back to how Morf came. Your files and models stay.">
                  {cleared.prefs ? (
                    <Done>Reset</Done>
                  ) : (
                    <ConfirmButton
                      confirm="Reset"
                      onConfirm={() => {
                        resetPrefs()
                        mark("prefs")
                      }}
                    >
                      Reset
                    </ConfirmButton>
                  )}
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* Engine */}
            <SettingsPane value="engine" title="Engine" description="The tools that do the work. All of them come with Morf and run offline.">
              <SettingsGroup title="Audio and video">
                <SettingsRow
                  label="ffmpeg"
                  description={
                    status?.ffmpeg
                      ? `${status.ffmpeg.version} · ${status.ffmpeg.bundled ? "bundled" : status.ffmpeg.path}`
                      : status
                        ? "Not found. Reinstall Morf, or run: winget install Gyan.FFmpeg"
                        : "Checking…"
                  }
                >
                  <span className={cn("label rounded-full bg-paper-2 px-2 py-1", status?.ffmpeg ? "text-ok" : "text-signal")}>{status?.ffmpeg ? "Ready" : status ? "Missing" : "…"}</span>
                </SettingsRow>
                <SettingsRow
                  label="Hardware encoding"
                  description={
                    status && status.hwEncoders.length
                      ? `Uses ${status.hwEncoders.join(", ")} for H.264 and HEVC. Faster; slightly larger files at the same quality.`
                      : "No hardware encoder found on this computer; software encoders are used."
                  }
                >
                  <SettingsSwitch checked={prefs.hardware} onCheckedChange={(v) => setPref("hardware", v)} />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* Writing */}
            <SettingsPane value="writing" title="Writing" description="Settings for Count and its grammar check.">
              <SettingsGroup>
                <SettingsRow label="English dialect" description="Changes spelling suggestions: colour or color.">
                  <SettingsSegmented
                    value={prefs.dialect}
                    onValueChange={(v) => setPref("dialect", v as typeof prefs.dialect)}
                    options={[
                      { value: "American", label: "US" },
                      { value: "British", label: "UK" },
                      { value: "Canadian", label: "CA" },
                      { value: "Australian", label: "AU" },
                    ]}
                  />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* Shortcuts */}
            <SettingsPane value="shortcuts" title="Shortcuts">
              <SettingsGroup title="Anywhere in Morf">
                {[
                  ["Search tools and actions", `${modKey} K`],
                  ["Settings", `${modKey} ,`],
                  ["Back to the index", "Esc"],
                  ["Move through the index", "↑ ↓"],
                  ["Open the tool in focus", "Enter"],
                ].map(([label, keys]) => (
                  <SettingsRow key={label} label={label}>
                    <Kbd>{keys}</Kbd>
                  </SettingsRow>
                ))}
              </SettingsGroup>
              <SettingsGroup title="Open a tool">
                {TOOLS.filter((t) => t.shortcut).map((t) => (
                  <SettingsRow key={t.id} label={t.name}>
                    <Kbd>{`${modKey} ${t.shortcut}`}</Kbd>
                  </SettingsRow>
                ))}
              </SettingsGroup>
              <SettingsGroup title="In any app">
                <SettingsRow label="Dictate" description={shortcut ? "Hold to talk, or tap to start and tap again to stop. Change it in Dictate." : "Turn dictation on in Dictate to use it."}>
                  <Kbd>
                    {(shortcut ?? "ctrl+space")
                      .split("+")
                      .map((k) => k[0].toUpperCase() + k.slice(1))
                      .join(" ")}
                  </Kbd>
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            {/* About */}
            <SettingsPane value="about" title="About Morf">
              <div className="flex flex-col gap-4 text-[13px]/[20px] text-ink-2">
                <Wordmark size={64} className="text-ink" />
                <p className="label text-ink-4">Version {version}</p>
                <p className="max-w-prose">One place for the small jobs files need. Everything runs on this computer: no accounts, no uploads, no analytics.</p>
                <p className="max-w-prose text-ink-3">
                  Conversion rules build on Convert by Newton Studios (MIT), and dictation on Handy (MIT). Audio and video by ffmpeg (GPL). PDFs by pdf.js, pdf-lib and
                  lopdf. Text recognition by Tesseract. Grammar by Harper (Apache-2.0). Type: Inter Tight, Geist Mono, Instrument Serif (OFL).
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const url = "https://github.com/giancoferrari/morf"
                      if (!inTauri) return void window.open(url, "_blank")
                      const { openUrl } = await import("@tauri-apps/plugin-opener")
                      await openUrl(url)
                    }}
                  >
                    Source code
                  </Button>
                  <span className="label text-ink-4">Free and open source · GPL-3.0</span>
                </div>
              </div>
            </SettingsPane>
          </SettingsPanel>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
