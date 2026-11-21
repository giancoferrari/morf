/** Every tool Morf has or will have. The index, the command palette and routing read this list. */

export type ToolId =
  | "convert"
  | "compress"
  | "count"
  | "pdf"
  | "transcribe"
  | "cutout"
  | "ocr"
  | "resize"
  | "rename"
  | "extract"
  | "metadata"
  | "diff"
  | "qr"
  | "palette"
  | "recipes"

export type ToolCategory = "media" | "text" | "documents" | "files"

export interface Tool {
  id: ToolId
  name: string
  category: ToolCategory
  /** One line for the index and the palette. */
  blurb: string
  /** What the superscript beside the name counts. */
  count?: number
  countLabel?: string
  ready: boolean
  keywords: string[]
  shortcut?: string
}

export const CATEGORIES: { id: ToolCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "media", label: "Media" },
  { id: "documents", label: "Documents" },
  { id: "text", label: "Text" },
  { id: "files", label: "Files" },
]

export const TOOLS: Tool[] = [
  {
    id: "convert",
    name: "Convert",
    category: "media",
    blurb: "Audio, video and images into any other format. Batches, hardware encoding, nothing uploaded.",
    count: 28,
    countLabel: "formats",
    ready: true,
    keywords: ["format", "mp3", "mp4", "jpg", "png", "webp", "heic", "gif", "wav", "transcode"],
    shortcut: "1",
  },
  {
    id: "compress",
    name: "Compress",
    category: "media",
    blurb: "Make videos, audio, photos and PDFs a fraction of the size, or fit them under a limit.",
    count: 4,
    countLabel: "kinds",
    ready: true,
    keywords: ["shrink", "smaller", "reduce", "size", "optimize", "discord", "email"],
    shortcut: "2",
  },
  {
    id: "count",
    name: "Count",
    category: "text",
    blurb: "Words, characters, reading time, keyword density, reading level and a private grammar check.",
    count: 12,
    countLabel: "measures",
    ready: true,
    keywords: ["word counter", "characters", "grammar", "reading time", "case", "keyword density"],
    shortcut: "3",
  },
  {
    id: "pdf",
    name: "PDF",
    category: "documents",
    blurb: "Merge, split, reorder, rotate, sign and protect PDFs.",
    count: 8,
    countLabel: "actions",
    ready: false,
    keywords: ["merge", "split", "sign", "password", "rotate"],
  },
  {
    id: "transcribe",
    name: "Dictate",
    category: "text",
    blurb: "Hold a shortcut, speak, and your words are typed into any app. Transcribes recordings too.",
    count: 4,
    countLabel: "models",
    ready: true,
    keywords: ["speech to text", "voice", "dictation", "whisper", "parakeet", "transcribe", "subtitles", "srt", "handy", "wispr"],
    shortcut: "4",
  },
  {
    id: "cutout",
    name: "Cutout",
    category: "media",
    blurb: "Remove the background from photos with a local model. Saves a transparent PNG.",
    ready: true,
    keywords: ["remove background", "transparent", "png"],
  },
  {
    id: "ocr",
    name: "Read",
    category: "documents",
    blurb: "Pull the text out of photos, screenshots and scanned PDFs.",
    count: 7,
    countLabel: "languages",
    ready: true,
    keywords: ["ocr", "text recognition", "scan", "screenshot"],
  },
  {
    id: "resize",
    name: "Resize",
    category: "media",
    blurb: "Batch resize, crop and pad images to exact sizes, with presets for social and web.",
    count: 4,
    countLabel: "modes",
    shortcut: "5",
    ready: true,
    keywords: ["crop", "scale", "dimensions", "thumbnail"],
  },
  {
    id: "rename",
    name: "Rename",
    category: "files",
    blurb: "Rename hundreds of files at once with patterns, numbers and dates. Undo included.",
    shortcut: "6",
    ready: true,
    keywords: ["batch rename", "pattern", "sequence"],
  },
  {
    id: "extract",
    name: "Archive",
    category: "files",
    blurb: "Open and make zip, 7z, tar and rar archives.",
    ready: false,
    keywords: ["zip", "unzip", "7z", "rar", "tar"],
  },
  {
    id: "metadata",
    name: "Metadata",
    category: "files",
    blurb: "See and strip EXIF, GPS and document properties.",
    ready: false,
    keywords: ["exif", "gps", "privacy", "strip"],
  },
  {
    id: "diff",
    name: "Compare",
    category: "text",
    blurb: "See exactly what changed between two versions of a text, by word, line or character.",
    count: 3,
    countLabel: "modes",
    shortcut: "7",
    ready: true,
    keywords: ["diff", "difference", "changes"],
  },
  {
    id: "qr",
    name: "QR",
    category: "text",
    blurb: "Make QR codes for links, Wi-Fi and contacts, or read one from a picture.",
    count: 5,
    countLabel: "kinds",
    shortcut: "8",
    ready: true,
    keywords: ["qr code", "barcode", "link"],
  },
  {
    id: "palette",
    name: "Palette",
    category: "media",
    blurb: "Pick any colour on screen, or pull a palette out of a picture.",
    count: 5,
    countLabel: "formats",
    shortcut: "9",
    ready: true,
    keywords: ["color", "colour", "hex", "picker", "swatch"],
  },
  {
    id: "recipes",
    name: "Recipes",
    category: "files",
    blurb: "Chain tools together and run them on a watch folder.",
    ready: false,
    keywords: ["automation", "workflow", "watch folder", "pipeline", "chain"],
  },
]

export function getTool(id: ToolId): Tool {
  return TOOLS.find((t) => t.id === id)!
}
