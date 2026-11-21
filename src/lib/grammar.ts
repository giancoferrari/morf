/**
 * Grammar and spelling through Harper, a checker that runs as WebAssembly in a worker: nothing is
 * sent anywhere. Loaded the first time Count asks, since the binary is large.
 */
import type { Lint, Linter, Suggestion } from "harper.js"

export interface Issue {
  id: string
  /** UTF-16 offsets into the text, ready for String.slice. */
  start: number
  end: number
  kind: string
  message: string
  problem: string
  suggestions: { label: string; index: number }[]
  lint: Lint
  raw: Suggestion[]
}

let linterPromise: Promise<Linter> | null = null
let currentDialect: string | null = null

async function getLinter(dialect: string): Promise<Linter> {
  if (!linterPromise) {
    linterPromise = (async () => {
      const [{ WorkerLinter, Dialect }, { binary }] = await Promise.all([import("harper.js"), import("harper.js/binary")])
      const linter = new WorkerLinter({ binary, dialect: Dialect[dialect as keyof typeof Dialect] })
      currentDialect = dialect
      await linter.setup()
      return linter
    })()
  }
  const linter = await linterPromise
  if (currentDialect !== dialect) {
    const { Dialect } = await import("harper.js")
    await linter.setDialect(Dialect[dialect as keyof typeof Dialect])
    currentDialect = dialect
  }
  return linter
}

/** Harper counts in Unicode scalar values; the editor counts in UTF-16 units. */
function scalarToUtf16(text: string): (i: number) => number {
  if (!/[\uD800-\uDBFF]/.test(text)) return (i) => i
  const map: number[] = []
  let u = 0
  for (const ch of text) {
    map.push(u)
    u += ch.length
  }
  map.push(u)
  return (i) => map[Math.min(i, map.length - 1)]
}

export async function checkGrammar(text: string, dialect = "American"): Promise<Issue[]> {
  if (!text.trim()) return []
  const linter = await getLinter(dialect)
  const lints = await linter.lint(text, { language: "plaintext" })
  const toU = scalarToUtf16(text)
  return lints.map((l, i) => {
    const span = l.span()
    const raw = l.suggestions()
    return {
      id: `${span.start}-${span.end}-${i}`,
      start: toU(span.start),
      end: toU(span.end),
      kind: l.lint_kind_pretty(),
      message: l.message(),
      problem: l.get_problem_text(),
      suggestions: raw.slice(0, 4).map((s, index) => {
        const text = s.get_replacement_text()
        return { label: text === "" ? "Remove" : text, index }
      }),
      lint: l,
      raw,
    }
  })
}

export async function applyFix(text: string, issue: Issue, index: number, dialect = "American"): Promise<string> {
  const linter = await getLinter(dialect)
  return linter.applySuggestion(text, issue.lint, issue.raw[index])
}
