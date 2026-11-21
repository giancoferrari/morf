/** Text measures for Count. Pure functions, fast enough to run on every keystroke for a book chapter. */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-_]*/gu

export interface TextStats {
  words: number
  characters: number
  charactersNoSpaces: number
  sentences: number
  paragraphs: number
  syllables: number
  uniqueWords: number
  avgWordLength: number
  avgSentenceLength: number
  longestSentence: number
  readingSeconds: number
  speakingSeconds: number
  /** Flesch reading ease, 0–100+ (higher is easier). */
  readingEase: number
  /** Flesch–Kincaid grade. */
  grade: number
}

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null
const sentencesSeg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "sentence" }) : null

function countGraphemes(s: string): number {
  if (!graphemes) return [...s].length
  let n = 0
  for (const _ of graphemes.segment(s)) n++
  return n
}

export function words(text: string): string[] {
  return text.match(WORD_RE) ?? []
}

export function splitSentences(text: string): string[] {
  if (!text.trim()) return []
  if (sentencesSeg) {
    const out: string[] = []
    for (const s of sentencesSeg.segment(text)) {
      // Line breaks end sentences too (headings, list items).
      for (const part of s.segment.split(/\n+/)) if (/[\p{L}\p{N}]/u.test(part)) out.push(part.trim())
    }
    return out
  }
  return text.split(/(?<=[.!?…])\s+|\n+/).filter((s) => /[\p{L}\p{N}]/u.test(s))
}

/** English syllable estimate: vowel groups, minus silent endings. Good to within a few percent. */
export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "")
  if (!w) return 0
  if (w.length <= 3) return 1
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "")
  const groups = w.match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups ? groups.length : 1)
}

export function computeStats(text: string): TextStats {
  const ws = words(text)
  const sents = splitSentences(text)
  const paragraphs = text.split(/\n+/).filter((p) => /[\p{L}\p{N}]/u.test(p)).length
  const syl = ws.reduce((n, w) => n + syllables(w), 0)
  const unique = new Set(ws.map((w) => w.toLowerCase())).size
  const letters = ws.reduce((n, w) => n + w.length, 0)
  const sentenceLengths = sents.map((s) => words(s).length)
  const wps = sents.length ? ws.length / sents.length : 0
  const spw = ws.length ? syl / ws.length : 0
  return {
    words: ws.length,
    characters: countGraphemes(text),
    charactersNoSpaces: countGraphemes(text.replace(/\s+/g, "")),
    sentences: sents.length,
    paragraphs,
    syllables: syl,
    uniqueWords: unique,
    avgWordLength: ws.length ? letters / ws.length : 0,
    avgSentenceLength: wps,
    longestSentence: sentenceLengths.length ? Math.max(...sentenceLengths) : 0,
    // 238 wpm silent reading and 150 wpm speech are the averages most studies land on.
    readingSeconds: (ws.length / 238) * 60,
    speakingSeconds: (ws.length / 150) * 60,
    readingEase: ws.length ? 206.835 - 1.015 * wps - 84.6 * spw : 0,
    grade: ws.length ? 0.39 * wps + 11.8 * spw - 15.59 : 0,
  }
}

export function readingLevel(ease: number): { label: string; audience: string } {
  if (ease >= 90) return { label: "Very easy", audience: "Age 11 and up" }
  if (ease >= 80) return { label: "Easy", audience: "Age 12 and up" }
  if (ease >= 70) return { label: "Fairly easy", audience: "Age 13 and up" }
  if (ease >= 60) return { label: "Plain English", audience: "Age 14–15" }
  if (ease >= 50) return { label: "Fairly hard", audience: "Age 16–18" }
  if (ease >= 30) return { label: "Hard", audience: "University" }
  return { label: "Very hard", audience: "Graduate" }
}

const STOP = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below between both but by " +
    "can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't " +
    "have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't " +
    "it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own " +
    "same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's " +
    "these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were " +
    "weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're " +
    "you've your yours yourself yourselves also just like will one get got really much many us it’s don’t i’m"
  ).split(" "),
)

export interface Keyword {
  phrase: string
  count: number
  density: number
}

/** The most used words or phrases. Phrases never start or end on a stop word, and never span sentences. */
export function keywordDensity(text: string, n: 1 | 2 | 3, limit = 10): Keyword[] {
  const total = words(text).length
  if (!total) return []
  const counts = new Map<string, number>()
  for (const sentence of splitSentences(text)) {
    const ws = words(sentence).map((w) => w.toLowerCase())
    for (let i = 0; i + n <= ws.length; i++) {
      const gram = ws.slice(i, i + n)
      if (STOP.has(gram[0]) || STOP.has(gram[n - 1])) continue
      if (n === 1 && (gram[0].length < 3 || /^\d+$/.test(gram[0]))) continue
      const key = gram.join(" ")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => n === 1 || c > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count, density: (count * n) / total }))
}

export type CaseMode = "upper" | "lower" | "title" | "sentence" | "toggle"

const SMALL = new Set("a an and as at but by for in nor of on or per the to via vs".split(" "))

export function changeCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toUpperCase()
    case "lower":
      return text.toLowerCase()
    case "toggle":
      return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("")
    case "sentence":
      return text.toLowerCase().replace(/(^\s*|[.!?…]\s+|\n\s*)(\p{L})/gu, (_, pre: string, ch: string) => pre + ch.toUpperCase())
    case "title": {
      let first = true
      return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, (w) => {
        const lower = w.toLowerCase()
        const out = !first && SMALL.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1)
        first = false
        return out
      })
    }
  }
}
