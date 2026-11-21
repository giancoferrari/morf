import { useId } from "react"
import { ChevronDown } from "lucide-react"
import { SettingsRow, SettingsSegmented, SettingsSwitch } from "@/components/ui/settings-panel"
import type { JobSettings, OptionKey, Target } from "@/lib/engine"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------------------------------
 * Small controls in the settings-panel idiom: a select for long lists, a range for quality.
 * -----------------------------------------------------------------------------------------------*/

export function Select({
  value,
  options,
  onChange,
  className,
  ...aria
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  className?: string
  "aria-label"?: string
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="chatcn-focus h-7 cursor-pointer appearance-none rounded-md bg-paper-2 pr-7 pl-2.5 text-[13px] font-medium text-ink outline-none transition-colors hover:bg-paper-3"
        {...aria}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={13} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-3" />
    </span>
  )
}

export function Range({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  format = (v) => String(v),
  valueAlign = "end",
  ...aria
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  /** "end" lines values up at a row's edge (settings rows); "start" keeps a value beside its slider. */
  valueAlign?: "start" | "end"
  "aria-label"?: string
}) {
  const id = useId()
  const pct = ((value - min) / (max - min)) * 100
  return (
    <span className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="morf-range w-40"
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        {...aria}
      />
      <output htmlFor={id} className={cn("label text-ink tabular-nums", valueAlign === "end" ? "w-12 text-right" : "min-w-6 text-left")}>
        {format(value)}
      </output>
    </span>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Per-format options. The engine fills in anything left unset.
 * -----------------------------------------------------------------------------------------------*/

const opts = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }))

function bitrateOptions(target: Target) {
  if (target.id === "opus") return opts([["auto", "Auto"], ["192", "192 kbps"], ["160", "160 kbps"], ["128", "128 kbps"], ["96", "96 kbps"], ["64", "64 kbps"]])
  if (target.id === "mp3") return opts([["auto", "VBR high"], ["320", "320 kbps"], ["256", "256 kbps"], ["192", "192 kbps"], ["128", "128 kbps"], ["96", "96 kbps"]])
  return opts([["auto", "Auto"], ["320", "320 kbps"], ["256", "256 kbps"], ["192", "192 kbps"], ["128", "128 kbps"], ["96", "96 kbps"]])
}

export const DEFAULTS: Required<Pick<JobSettings, "bitrate" | "sampleRate" | "channels" | "bitDepth" | "quality" | "resolution" | "fps" | "keepAudio" | "gifWidth" | "gifFps" | "imageQuality" | "maxSize">> = {
  bitrate: "auto",
  sampleRate: "source",
  channels: "source",
  bitDepth: "16",
  quality: 70,
  resolution: "source",
  fps: "source",
  keepAudio: true,
  gifWidth: "480",
  gifFps: "15",
  imageQuality: 82,
  maxSize: "original",
}

export function OptionsForm({
  target,
  settings,
  onChange,
  hardwareAvailable,
}: {
  target: Target
  settings: JobSettings
  onChange: (patch: Partial<JobSettings>) => void
  hardwareAvailable: boolean
}) {
  const s = { ...DEFAULTS, ...settings }
  const row = (key: OptionKey) => {
    switch (key) {
      case "bitrate":
        return (
          <SettingsRow key={key} label="Bitrate" description="Higher keeps more detail; Auto picks a transparent quality.">
            <Select aria-label="Bitrate" value={s.bitrate} options={bitrateOptions(target)} onChange={(v) => onChange({ bitrate: v })} />
          </SettingsRow>
        )
      case "sampleRate":
        return (
          <SettingsRow key={key} label="Sample rate">
            <Select
              aria-label="Sample rate"
              value={s.sampleRate}
              options={opts([["source", "Same as source"], ["48000", "48 kHz"], ["44100", "44.1 kHz"], ["32000", "32 kHz"], ["22050", "22 kHz"]])}
              onChange={(v) => onChange({ sampleRate: v })}
            />
          </SettingsRow>
        )
      case "channels":
        return (
          <SettingsRow key={key} label="Channels">
            <SettingsSegmented
              size="xs"
              value={s.channels}
              onValueChange={(v) => onChange({ channels: v })}
              options={[
                { value: "source", label: "Source" },
                { value: "stereo", label: "Stereo" },
                { value: "mono", label: "Mono" },
              ]}
            />
          </SettingsRow>
        )
      case "bitDepth":
        return (
          <SettingsRow key={key} label="Bit depth">
            <SettingsSegmented
              size="xs"
              value={s.bitDepth}
              onValueChange={(v) => onChange({ bitDepth: v })}
              options={[
                { value: "16", label: "16-bit" },
                { value: "24", label: "24-bit" },
              ]}
            />
          </SettingsRow>
        )
      case "quality":
        return (
          <SettingsRow key={key} label="Quality" description="Lower makes smaller files.">
            <Range aria-label="Quality" value={s.quality} min={10} max={100} onChange={(v) => onChange({ quality: v })} />
          </SettingsRow>
        )
      case "resolution":
        return (
          <SettingsRow key={key} label="Resolution" description="Never upscales.">
            <Select
              aria-label="Resolution"
              value={s.resolution}
              options={opts([["source", "Same as source"], ["2160", "4K · 2160p"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]])}
              onChange={(v) => onChange({ resolution: v })}
            />
          </SettingsRow>
        )
      case "fps":
        return (
          <SettingsRow key={key} label="Frame rate">
            <Select
              aria-label="Frame rate"
              value={s.fps}
              options={opts([["source", "Same as source"], ["60", "60 fps"], ["30", "30 fps"], ["24", "24 fps"]])}
              onChange={(v) => onChange({ fps: v })}
            />
          </SettingsRow>
        )
      case "keepAudio":
        return (
          <SettingsRow key={key} label="Keep audio">
            <SettingsSwitch checked={s.keepAudio} onCheckedChange={(v) => onChange({ keepAudio: v })} />
          </SettingsRow>
        )
      case "hardware":
        return (
          <SettingsRow
            key={key}
            label="Hardware encoding"
            description={hardwareAvailable ? "Much faster. Falls back to software if it fails." : "No hardware encoder on this computer."}
            disabled={!hardwareAvailable}
          >
            <SettingsSwitch checked={hardwareAvailable && settings.hardware !== false} onCheckedChange={(v) => onChange({ hardware: v })} />
          </SettingsRow>
        )
      case "gifWidth":
        return (
          <SettingsRow key={key} label="Width">
            <Select
              aria-label="GIF width"
              value={s.gifWidth}
              options={opts([["320", "320 px"], ["480", "480 px"], ["640", "640 px"], ["800", "800 px"], ["source", "Same as source"]])}
              onChange={(v) => onChange({ gifWidth: v })}
            />
          </SettingsRow>
        )
      case "gifFps":
        return (
          <SettingsRow key={key} label="Frame rate">
            <SettingsSegmented
              size="xs"
              value={s.gifFps}
              onValueChange={(v) => onChange({ gifFps: v })}
              options={["10", "15", "20", "25"].map((v) => ({ value: v, label: v }))}
            />
          </SettingsRow>
        )
      case "imageQuality":
        return (
          <SettingsRow key={key} label="Quality" description="82 is hard to tell from the original.">
            <Range aria-label="Image quality" value={s.imageQuality} min={30} max={100} onChange={(v) => onChange({ imageQuality: v })} />
          </SettingsRow>
        )
      case "maxSize":
        return (
          <SettingsRow key={key} label="Longest side" description="Shrinks bigger images; never enlarges.">
            <Select
              aria-label="Longest side"
              value={s.maxSize}
              options={opts([["original", "Original"], ["4096", "4096 px"], ["2560", "2560 px"], ["1920", "1920 px"], ["1280", "1280 px"], ["800", "800 px"]])}
              onChange={(v) => onChange({ maxSize: v })}
            />
          </SettingsRow>
        )
    }
  }
  if (!target.options.length) return <p className="py-4 text-[13px] text-ink-3">This format has no settings.</p>
  return <div className="divide-y divide-hair border-t border-hair">{target.options.map(row)}</div>
}
