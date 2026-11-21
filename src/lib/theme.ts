import { useEffect } from "react"
import { usePrefs } from "./prefs"

/** Puts `.dark` on <html> from the preference, following the OS while it is "system". */
export function useApplyTheme() {
  const { theme, reduceMotion } = usePrefs()
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches)
      document.documentElement.classList.toggle("dark", dark)
    }
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [theme])
  useEffect(() => {
    document.documentElement.toggleAttribute("data-reduce-motion", reduceMotion)
  }, [reduceMotion])
}
