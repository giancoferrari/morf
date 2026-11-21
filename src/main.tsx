import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { Overlay } from "./screens/Overlay.tsx"

// The dictation pill is a second, transparent window that loads this same bundle.
const isOverlay = window.location.hash === "#overlay"

createRoot(document.getElementById("root")!).render(<StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>)
