/** Colour maths for Palette: conversions, contrast, shades, and palette extraction. */

export type RGB = [number, number, number]

export const hex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()

export function parseHex(s: string): RGB | null {
  const m = s.trim().replace(/^#/, "")
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB
}

const toLinear = (c: number) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function toOklab([r, g, b]: RGB): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

export function fromOklab([L, a, b]: [number, number, number]): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return rgb.map((v) => Math.max(0, Math.min(255, fromLinear(v)))) as RGB
}

export function oklch(rgb: RGB): [number, number, number] {
  const [L, a, b] = toOklab(rgb)
  const C = Math.hypot(a, b)
  const H = (Math.atan2(b, a) * 180) / Math.PI
  return [L, C, (H + 360) % 360]
}

export function hsl([r, g, b]: RGB): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

export function cmyk([r, g, b]: RGB): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b) / 255
  if (k >= 1) return [0, 0, 0, 100]
  return [((1 - r / 255 - k) / (1 - k)) * 100, ((1 - g / 255 - k) / (1 - k)) * 100, ((1 - b / 255 - k) / (1 - k)) * 100, k * 100]
}

export function luminance(rgb: RGB) {
  const [r, g, b] = rgb.map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: RGB, b: RGB) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

export function formats(rgb: RGB) {
  const [h, s, l] = hsl(rgb)
  const [L, C, H] = oklch(rgb)
  const [c, m, y, k] = cmyk(rgb)
  const r = (v: number, d = 0) => Number(v.toFixed(d))
  return [
    { label: "HEX", value: hex(rgb) },
    { label: "RGB", value: `rgb(${rgb.map((v) => Math.round(v)).join(", ")})` },
    { label: "HSL", value: `hsl(${r(h)} ${r(s)}% ${r(l)}%)` },
    { label: "OKLCH", value: `oklch(${r(L * 100, 1)}% ${r(C, 3)} ${r(H, 1)})` },
    { label: "CMYK", value: `${r(c)} ${r(m)} ${r(y)} ${r(k)}` },
  ]
}

/** Nine steps from near-white to near-black at the same hue, evenly spaced in OKLab lightness. */
export function shades(rgb: RGB): RGB[] {
  const [, a, b] = toOklab(rgb)
  return [0.96, 0.88, 0.78, 0.68, 0.58, 0.48, 0.38, 0.28, 0.18].map((L) => fromOklab([L, a * (1 - Math.abs(L - 0.6) * 0.6), b * (1 - Math.abs(L - 0.6) * 0.6)]))
}

/**
 * The main colours of an image: k-means in OKLab (so "different" means different to the eye),
 * seeded by k-means++ for stable results. Returns colours sorted by how much of the image they cover.
 */
export function extractPalette(pixels: Uint8ClampedArray, k: number): { rgb: RGB; share: number }[] {
  const pts: [number, number, number][] = []
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue
    pts.push(toOklab([pixels[i], pixels[i + 1], pixels[i + 2]]))
  }
  if (!pts.length) return []
  k = Math.min(k, pts.length)
  const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
  // Deterministic k-means++: start from the point closest to the mean, then farthest-weighted.
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const centers: number[][] = [pts[Math.floor(pts.length / 2)]]
  while (centers.length < k) {
    const dist = pts.map((p) => Math.min(...centers.map((c) => d2(p, c))))
    const total = dist.reduce((a, b) => a + b, 0)
    let r = rand() * total
    let idx = 0
    while (r > dist[idx] && idx < pts.length - 1) r -= dist[idx++]
    centers.push(pts[idx])
  }
  const assign = new Array(pts.length).fill(0)
  for (let iter = 0; iter < 14; iter++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0
      let bd = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = d2(pts[i], centers[c])
        if (d < bd) {
          bd = d
          best = c
        }
      }
      assign[i] = best
    }
    const sums = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < pts.length; i++) {
      const s = sums[assign[i]]
      s[0] += pts[i][0]
      s[1] += pts[i][1]
      s[2] += pts[i][2]
      s[3]++
    }
    sums.forEach((s, c) => {
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]
    })
  }
  const counts = centers.map(() => 0)
  assign.forEach((c) => counts[c]++)
  return centers
    .map((c, i) => ({ lab: c, share: counts[i] / pts.length }))
    .filter((c) => c.share > 0.004)
    .sort((a, b) => b.share - a.share)
    .map((c) => ({ rgb: fromOklab(c.lab as [number, number, number]), share: c.share, lab: c.lab }))
}

/**
 * A palette people would pick by eye: clusters finely, then keeps colours that are both common
 * and clearly different from the ones already chosen, so three near-blacks don't crowd out an
 * accent that covers 4% of the picture.
 */
export function distinctPalette(pixels: Uint8ClampedArray, k: number): { rgb: RGB; share: number }[] {
  const candidates = extractPalette(pixels, Math.min(24, k * 3)) as { rgb: RGB; share: number; lab: number[] }[]
  if (!candidates.length) return []
  const dist = (p: number[], q: number[]) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2)
  const chosen = [candidates[0]]
  while (chosen.length < k) {
    let best: (typeof candidates)[number] | null = null
    let bestScore = 0
    for (const c of candidates) {
      if (chosen.includes(c)) continue
      const d = Math.min(...chosen.map((x) => dist(x.lab, c.lab)))
      if (d < 0.035) continue
      // Distance counts more than coverage: a small accent beats a fourth shade of grey.
      const score = Math.pow(c.share, 0.3) * d
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    if (!best) break
    chosen.push(best)
  }
  // Fold every candidate's share into the nearest chosen colour, so shares still add up.
  const shares = chosen.map(() => 0)
  for (const c of candidates) {
    let bi = 0
    for (let i = 1; i < chosen.length; i++) if (dist(chosen[i].lab, c.lab) < dist(chosen[bi].lab, c.lab)) bi = i
    shares[bi] += c.share
  }
  return chosen.map((c, i) => ({ rgb: c.rgb, share: shares[i] })).sort((a, b) => b.share - a.share)
}
