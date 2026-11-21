import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath, URL } from "node:url"
import { defineConfig, type Plugin } from "vite"
import { createReadStream, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const host = process.env.TAURI_DEV_HOST

/**
 * Dev only: serves design-time test files from dev-fixtures/ (git-ignored) at /_test/. They live
 * outside public/ so they can never end up inside the app.
 */
const devFixtures = (): Plugin => ({
  name: "morf-dev-fixtures",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/_test", (req, res, next) => {
      const root = fileURLToPath(new URL("./dev-fixtures", import.meta.url))
      const file = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]))
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()
      res.setHeader("Content-Length", statSync(file).size)
      if (req.method === "HEAD") return res.end()
      createReadStream(file).pipe(res)
    })
  },
})

// Tauri expects a fixed port and must not have the dev server clear its output.
export default defineConfig({
  plugins: [react(), tailwindcss(), devFixtures()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "oxc" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
