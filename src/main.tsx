import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { Overlay } from "./screens/Overlay.tsx"
import { Picker } from "./screens/Picker.tsx"

// Extra windows load this same bundle: the dictation pill (#overlay) and the colour picker that
// covers each monitor (#picker-0, #picker-1…).
const hash = window.location.hash
const picker = /^#picker-(\d+)$/.exec(hash)

createRoot(document.getElementById("root")!).render(
  <StrictMode>{hash === "#overlay" ? <Overlay /> : picker ? <Picker index={Number(picker[1])} /> : <App />}</StrictMode>,
)
