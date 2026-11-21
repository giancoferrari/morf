#!/usr/bin/env node
// Copies the runtime files of in-window engines into public/vendor, so Morf works offline:
// Tesseract (Read) with English data, and ONNX Runtime (Cutout). Runs before dev and build.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const nm = join(root, "node_modules")
const out = join(root, "public", "vendor")

const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
}

// Tesseract: worker, the wasm cores (SIMD and plain, LSTM only), and English (best_int).
copy(join(nm, "tesseract.js", "dist", "worker.min.js"), join(out, "tesseract", "worker.min.js"))
for (const f of readdirSync(join(nm, "tesseract.js-core"))) {
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.(wasm|wasm\.js|js)$/.test(f)) copy(join(nm, "tesseract.js-core", f), join(out, "tesseract", "core", f))
}
copy(join(nm, "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), join(out, "tesseract", "lang", "eng.traineddata.gz"))

// ONNX Runtime Web: the asyncify WebAssembly (serves both WebGPU and CPU). Its loader is bundled.
for (const f of ["ort-wasm-simd-threaded.asyncify.wasm"]) {
  copy(join(nm, "onnxruntime-web", "dist", f), join(out, "ort", f))
}

// pdf.js worker for reading scanned PDFs.
copy(join(nm, "pdfjs-dist", "build", "pdf.worker.min.mjs"), join(out, "pdfjs", "pdf.worker.min.mjs"))

console.log("vendor files ready in public/vendor")
if (!existsSync(join(out, "tesseract", "lang", "eng.traineddata.gz"))) process.exit(1)
