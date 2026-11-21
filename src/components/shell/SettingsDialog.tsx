import { useEffect, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { Cpu, FolderOutput, Info, Monitor, Moon, PenLine, SlidersHorizontal, Sun, X } from "lucide-react"
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
import { engineStatus, pickFolder, setShellMenu, type EngineStatus } from "@/lib/engine"
import { setPref, usePrefs } from "@/lib/prefs"
import { basename, cn } from "@/lib/utils"

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const prefs = usePrefs()
  const [status, setStatus] = useState<EngineStatus | null>(null)
  useEffect(() => {
    if (open) void engineStatus().then(setStatus).catch(() => setStatus(null))
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-paper/60 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(880px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-card shadow-float outline-none",
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

          <SettingsPanel defaultValue="general" className="h-[min(600px,calc(100vh-80px))]">
            <SettingsNav
              title="Settings"
              footer={
                <div className="label px-2 text-ink-4">
                  Morf 0.2.0
                  <br />
                  Runs on this computer
                </div>
              }
            >
              <SettingsNavItem value="general" icon={<SlidersHorizontal />}>General</SettingsNavItem>
              <SettingsNavItem value="output" icon={<FolderOutput />}>Output</SettingsNavItem>
              <SettingsNavItem value="engine" icon={<Cpu />} meta={status?.ffmpeg ? "Ready" : status ? "Missing" : undefined}>
                Engine
              </SettingsNavItem>
              <SettingsNavItem value="writing" icon={<PenLine />}>Writing</SettingsNavItem>
              <SettingsNavItem value="about" icon={<Info />}>About</SettingsNavItem>
            </SettingsNav>

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
              <SettingsGroup title="When a batch finishes">
                <SettingsRow label="Show a notification" description="Only while Morf is in the background.">
                  <SettingsSwitch checked={prefs.notifyWhenDone} onCheckedChange={(v) => setPref("notifyWhenDone", v)} />
                </SettingsRow>
                <SettingsRow label="Reveal the results" description="Opens the folder with the first new file selected.">
                  <SettingsSwitch checked={prefs.revealWhenDone} onCheckedChange={(v) => setPref("revealWhenDone", v)} />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            <SettingsPane value="output" title="Output" description="Morf never overwrites a file. If a name is taken, the new file gets a number: photo 2.jpg.">
              <SettingsGroup title="Where new files go">
                <SettingsRow label="Location" description="A read-only folder always falls back to Downloads.">
                  <SettingsSegmented
                    value={prefs.outputMode}
                    onValueChange={(v) => setPref("outputMode", v as typeof prefs.outputMode)}
                    options={[
                      { value: "beside", label: "Next to original" },
                      { value: "folder", label: "One folder" },
                    ]}
                  />
                </SettingsRow>
                <SettingsRow
                  label="Folder"
                  description={prefs.outputFolder ?? "None chosen yet"}
                  disabled={prefs.outputMode !== "folder"}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={prefs.outputMode !== "folder"}
                    onClick={async () => {
                      const f = await pickFolder()
                      if (f) setPref("outputFolder", f)
                    }}
                  >
                    {prefs.outputFolder ? `Change (${basename(prefs.outputFolder)})` : "Chooseâ€¦"}
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
                <SettingsRow
                  label="Move originals to the Trash"
                  description="Only after the new file exists. You can put them back from the Trash or Recycle Bin."
                >
                  <SettingsSwitch checked={prefs.trashOriginals} onCheckedChange={(v) => setPref("trashOriginals", v)} />
                </SettingsRow>
                <SettingsRow label="Remember format settings" description="Keep what you choose under Advanced for each format.">
                  <SettingsSwitch
                    checked={prefs.rememberFormatSettings}
                    onCheckedChange={(v) => setPref("rememberFormatSettings", v)}
                  />
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>

            <SettingsPane value="engine" title="Engine" description="The tools that do the work. All of them come with Morf and run offline.">
              <SettingsGroup title="Audio and video">
                <SettingsRow
                  label="ffmpeg"
                  description={
                    status?.ffmpeg
                      ? `${status.ffmpeg.version} Â· ${status.ffmpeg.bundled ? "bundled" : status.ffmpeg.path}`
                      : status
                        ? "Not found. Reinstall Morf, or run: winget install Gyan.FFmpeg"
                        : "Checkingâ€¦"
                  }
                >
                  <span
                    className={cn(
                      "label rounded-full px-2 py-1",
                      status?.ffmpeg ? "bg-paper-2 text-ok" : "bg-paper-2 text-signal",
                    )}
                  >
                    {status?.ffmpeg ? "Ready" : status ? "Missing" : "â€¦"}
                  </span>
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

            <SettingsPane value="about" title="About Morf">
              <div className="flex flex-col gap-4 text-[13px]/[20px] text-ink-2">
                <Wordmark size={64} className="text-ink" />
                <p className="max-w-prose">
                  One place for the small jobs files need. Everything runs on this computer: no accounts, no uploads,
                  no analytics.
                </p>
                <p className="max-w-prose text-ink-3">
                  Conversion rules build on Convert by Newton Studios (MIT). Audio and video by ffmpeg (GPL). Grammar
                  by Harper (Apache-2.0). Type: Inter Tight, Geist Mono, Instrument Serif (OFL).
                </p>
              </div>
            </SettingsPane>
          </SettingsPanel>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
