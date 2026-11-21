import { useEffect, useMemo, useRef, useState } from "react"
import QRCode from "qrcode"
import jsQR from "jsqr"
import { ToolHeader } from "@/components/files"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSegmented } from "@/components/ui/settings-panel"
import { files as fileApi, inTauri, onWindowDrop, pickFiles } from "@/lib/engine"
import { loadJSON, saveJSON } from "@/lib/prefs"
import { announceSaved } from "@/lib/saved"
import { cn } from "@/lib/utils"

type Kind = "link" | "text" | "wifi" | "email" | "phone"
type Level = "L" | "M" | "Q" | "H"

interface Form {
  kind: Kind
  link: string
  text: string
  ssid: string
  password: string
  security: "WPA" | "WEP" | "nopass"
  email: string
  subject: string
  phone: string
  level: Level
  dark: string
  light: string
  margin: number
}

const DEFAULT_FORM: Form = {
  kind: "link",
  link: "https://",
  text: "",
  ssid: "",
  password: "",
  security: "WPA",
  email: "",
  subject: "",
  phone: "",
  level: "M",
  dark: "#111111",
  light: "#ffffff",
  margin: 2,
}

const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1")

function payload(f: Form): string {
  switch (f.kind) {
    case "link":
      return f.link.trim() === "https://" ? "" : f.link.trim()
    case "text":
      return f.text
    case "wifi":
      return f.ssid ? `WIFI:T:${f.security};S:${esc(f.ssid)};P:${f.security === "nopass" ? "" : esc(f.password)};;` : ""
    case "email":
      return f.email ? `mailto:${f.email}${f.subject ? `?subject=${encodeURIComponent(f.subject)}` : ""}` : ""
    case "phone":
      return f.phone ? `tel:${f.phone.replace(/[^\d+]/g, "")}` : ""
  }
}

const COLOURS: { name: string; dark: string; light: string }[] = [
  { name: "Ink", dark: "#111111", light: "#ffffff" },
  { name: "Paper", dark: "#1c1b19", light: "#f6f5f1" },
  { name: "Night", dark: "#f6f5f1", light: "#111111" },
  { name: "Signal", dark: "#d9481c", light: "#ffffff" },
]

const Field = ({ label, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
  <label className="flex flex-col gap-1.5">
    <span className="label text-ink-4">{label}</span>
    <input {...p} className="chatcn-focus h-11 w-full rounded-lg bg-paper-2 px-3.5 text-[15px] text-ink outline-none placeholder:text-ink-4" />
  </label>
)

/** Tries the picture at a few sizes; small codes in big screenshots are found after scaling. */
async function decode(url: string): Promise<string | null> {
  const img = new Image()
  img.src = url
  await img.decode()
  for (const max of [1600, 1000, 2400, 700]) {
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * s))
    const h = Math.max(1, Math.round(img.naturalHeight * s))
    const c = document.createElement("canvas")
    c.width = w
    c.height = h
    const ctx = c.getContext("2d", { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    const r = jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" })
    if (r?.data) return r.data
  }
  return null
}

export function QrScreen() {
  const [tab, setTab] = useState<"make" | "read">("make")
  const [f, setF] = useState<Form>(() => ({ ...DEFAULT_FORM, ...loadJSON<Partial<Form>>("qr.form", {}) }))
  const [svg, setSvg] = useState("")
  const [read, setRead] = useState<{ text: string | null; src: string } | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const tabRef = useRef(tab)
  tabRef.current = tab

  const patch = (p: Partial<Form>) =>
    setF((prev) => {
      const next = { ...prev, ...p }
      saveJSON("qr.form", next)
      return next
    })
  const data = useMemo(() => payload(f), [f])

  useEffect(() => {
    if (!data) return setSvg("")
    QRCode.toString(data, { type: "svg", errorCorrectionLevel: f.level, margin: f.margin, color: { dark: f.dark, light: f.light } })
      .then(setSvg)
      .catch(() => setSvg(""))
  }, [data, f.level, f.margin, f.dark, f.light])

  const readFrom = async (path: string) => {
    setReadError(null)
    try {
      const url = await fileApi.previewUrl(path)
      if (!url) throw new Error("Morf can't open this picture.")
      const text = await decode(url)
      setRead({ text, src: url })
    } catch (e) {
      setReadError(String(e))
    }
  }

  // Drops go to Read.
  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void onWindowDrop({
      over: setDragging,
      drop: (p) => {
        setTab("read")
        if (p[0]) void readFrom(p[0])
      },
    }).then((u) => (dead ? u() : (off = u)))
    return () => {
      dead = true
      off?.()
    }
  }, [])

  // Ctrl+V with a screenshot on the clipboard reads it.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"))
      if (!item) return
      e.preventDefault()
      const url = URL.createObjectURL(item.getAsFile()!)
      setTab("read")
      setReadError(null)
      setRead({ text: await decode(url), src: url })
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [])

  const png = async (size = 1200) => {
    const url = await QRCode.toDataURL(data, { errorCorrectionLevel: f.level, margin: f.margin, width: size, color: { dark: f.dark, light: f.light } })
    return Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0))
  }
  const fileStem = (f.kind === "link" ? data.replace(/^https?:\/\//, "").split(/[/?#]/)[0] : f.kind === "wifi" ? `wifi ${f.ssid}` : "qr").replace(/[^\w.\- ]+/g, "") || "qr"

  const isUrl = read?.text && /^https?:\/\//i.test(read.text)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolHeader title="QR">
        <div className="flex flex-col gap-3">
          <p className="max-w-[34ch] text-[13px]/[19px] text-ink-3">Make QR codes for links, Wi-Fi and contacts, or read one from a picture.</p>
          <SettingsSegmented
            size="sm"
            className="self-start"
            aria-label="Make or read"
            value={tab}
            onValueChange={(v) => setTab(v as "make" | "read")}
            options={[
              { value: "make", label: "Make" },
              { value: "read", label: "Read" },
            ]}
          />
        </div>
      </ToolHeader>

      {tab === "make" ? (
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair">
          <section className="scroll-quiet col-span-6 min-h-0 overflow-y-auto pr-5 pl-5 pb-8">
            <div className="label py-3 text-ink-4">What</div>
            <div className="flex flex-wrap gap-x-4">
              {(
                [
                  ["link", "Link"],
                  ["text", "Text"],
                  ["wifi", "Wi-Fi"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                ] as [Kind, string][]
              ).map(([k, l]) => (
                <button key={k} onClick={() => patch({ kind: k })} className={cn("focus-ring text-[30px]/[1.15] font-[540] tracking-[-0.035em] transition-colors", f.kind === k ? "text-ink" : "text-ghost hover:text-ink-4")}>
                  {l}
                </button>
              ))}
            </div>
            <div className="mt-6 flex max-w-lg flex-col gap-4">
              {f.kind === "link" ? <Field label="Address" value={f.link} onChange={(e) => patch({ link: e.target.value })} autoFocus /> : null}
              {f.kind === "text" ? (
                <label className="flex flex-col gap-1.5">
                  <span className="label text-ink-4">Text</span>
                  <textarea value={f.text} onChange={(e) => patch({ text: e.target.value })} rows={4} className="chatcn-focus w-full resize-none rounded-lg bg-paper-2 px-3.5 py-3 text-[15px] text-ink outline-none" />
                </label>
              ) : null}
              {f.kind === "wifi" ? (
                <>
                  <Field label="Network name" value={f.ssid} onChange={(e) => patch({ ssid: e.target.value })} />
                  <Field label="Password" value={f.password} onChange={(e) => patch({ password: e.target.value })} disabled={f.security === "nopass"} />
                  <SettingsSegmented
                    size="xs"
                    aria-label="Security"
                    value={f.security}
                    onValueChange={(v) => patch({ security: v as Form["security"] })}
                    options={[
                      { value: "WPA", label: "WPA / WPA2 / WPA3" },
                      { value: "WEP", label: "WEP" },
                      { value: "nopass", label: "Open" },
                    ]}
                  />
                </>
              ) : null}
              {f.kind === "email" ? (
                <>
                  <Field label="Email address" value={f.email} onChange={(e) => patch({ email: e.target.value })} />
                  <Field label="Subject (optional)" value={f.subject} onChange={(e) => patch({ subject: e.target.value })} />
                </>
              ) : null}
              {f.kind === "phone" ? <Field label="Phone number" value={f.phone} onChange={(e) => patch({ phone: e.target.value })} /> : null}
            </div>

            <div className="mt-8 max-w-lg divide-y divide-hair border-t border-hair">
              <SettingsRow label="Colours">
                <div className="flex gap-1.5">
                  {COLOURS.map((c) => (
                    <button
                      key={c.name}
                      title={c.name}
                      onClick={() => patch({ dark: c.dark, light: c.light })}
                      className={cn("chatcn-focus grid size-8 place-items-center rounded-full ring-1 ring-hair-strong", f.dark === c.dark && f.light === c.light && "ring-2 ring-ink")}
                      style={{ background: c.light }}
                    >
                      <span className="size-3.5 rounded-[3px]" style={{ background: c.dark }} />
                    </button>
                  ))}
                  {/* Custom ink: a round swatch like the others, with the system colour picker under it. */}
                  <label
                    title="Custom colour"
                    className={cn(
                      "relative grid size-8 cursor-pointer place-items-center rounded-full ring-1 ring-hair-strong focus-within:ring-2 focus-within:ring-ink",
                      !COLOURS.some((c) => f.dark === c.dark && f.light === c.light) && "ring-2 ring-ink",
                    )}
                    style={{ background: "conic-gradient(from 90deg, #e5484d, #f5a524, #46a758, #0090ff, #8e4ec6, #e5484d)" }}
                  >
                    <span className="size-3.5 rounded-[3px] ring-1 ring-white/70" style={{ background: f.dark }} />
                    <input type="color" value={f.dark} onChange={(e) => patch({ dark: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom colour" />
                  </label>
                </div>
              </SettingsRow>
              <SettingsRow label="Error correction" description="Higher survives damage and logos on top, but is denser.">
                <SettingsSegmented
                  size="xs"
                  value={f.level}
                  onValueChange={(v) => patch({ level: v as Level })}
                  options={[
                    { value: "L", label: "Low" },
                    { value: "M", label: "Medium" },
                    { value: "Q", label: "High" },
                    { value: "H", label: "Max" },
                  ]}
                />
              </SettingsRow>
              <SettingsRow label="Quiet border">
                <SettingsSegmented
                  size="xs"
                  value={String(f.margin)}
                  onValueChange={(v) => patch({ margin: Number(v) })}
                  options={[
                    { value: "0", label: "None" },
                    { value: "2", label: "Small" },
                    { value: "4", label: "Standard" },
                  ]}
                />
              </SettingsRow>
            </div>
          </section>

          <section className="col-span-6 flex min-h-0 flex-col items-center justify-center gap-6 border-l border-hair p-8">
            {svg ? (
              <div className="anim-fade aspect-square w-[min(380px,100%)] overflow-hidden rounded-2xl shadow-float [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <div className="grid aspect-square w-[min(380px,100%)] place-items-center rounded-2xl border border-dashed border-hair-strong">
                <span className="label text-ink-4">Fill in the details</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="lg"
                variant="solid"
                disabled={!svg}
                onClick={async () => {
                  const p = await fileApi.saveAs(`${fileStem}.png`, await png(), [{ name: "PNG image", extensions: ["png"] }])
                  if (p) announceSaved("QR", [{ path: p }])
                }}
              >
                Save PNG
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={!svg}
                onClick={async () => {
                  const p = await fileApi.saveAs(`${fileStem}.svg`, svg, [{ name: "SVG image", extensions: ["svg"] }])
                  if (p) announceSaved("QR", [{ path: p }])
                }}
              >
                Save SVG
              </Button>
              <Button
                size="lg"
                variant="ghost"
                disabled={!svg}
                onClick={async () => {
                  const blob = new Blob([(await png(800)) as BlobPart], { type: "image/png" })
                  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1400)
                }}
              >
                {copied ? "Copied" : "Copy image"}
              </Button>
            </div>
          </section>
        </div>
      ) : (
        <div className={cn("grid min-h-0 flex-1 grid-cols-12 gap-x-5 border-t border-hair transition-colors", dragging && "bg-paper-2")}>
          <section className="col-span-6 flex min-h-0 flex-col justify-between p-5">
            <div className="flex flex-col gap-4">
              <p className={cn("display text-[clamp(52px,7vw,104px)] transition-colors", dragging ? "text-ink" : "text-ghost")}>{dragging ? "Let go" : "Drop a picture"}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="lg"
                  variant="outline"
                  onClick={async () => {
                    const [p] = await pickFiles()
                    if (p) void readFrom(p)
                  }}
                >
                  Choose picture
                </Button>
                <span className="label text-ink-4">or paste a screenshot with {navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} V</span>
              </div>
            </div>
            {read ? <img src={read.src} alt="" className="anim-fade max-h-[45%] max-w-full self-start rounded-xl object-contain shadow-float" /> : null}
          </section>
          <section className="col-span-6 flex min-h-0 flex-col gap-4 border-l border-hair p-5">
            <span className="label text-ink-4">Contents</span>
            {readError ? <p className="text-[14px] text-signal">{readError}</p> : null}
            {read ? (
              read.text ? (
                <>
                  <p className="text-[22px]/[30px] tracking-[-0.015em] break-words text-ink select-text">{read.text}</p>
                  <div className="flex gap-2">
                    <Button size="md" variant="solid" onClick={() => void navigator.clipboard.writeText(read.text!)}>
                      Copy
                    </Button>
                    {isUrl ? (
                      <Button
                        size="md"
                        variant="outline"
                        onClick={async () => {
                          if (inTauri) {
                            const { openUrl } = await import("@tauri-apps/plugin-opener")
                            await openUrl(read.text!)
                          } else window.open(read.text!, "_blank", "noopener")
                        }}
                      >
                        Open link
                      </Button>
                    ) : null}
                  </div>
                  {isUrl ? <p className="label text-ink-4">Check the address before opening a link from a code you don't trust.</p> : null}
                </>
              ) : (
                <p className="text-[15px] text-ink-3">No QR code found in this picture. Try a sharper or closer one.</p>
              )
            ) : (
              <p className="text-[15px] text-ink-3">The text, link or Wi-Fi details inside the code will appear here.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
