import markUrl from "@/assets/morf-mark.png"
import { cn } from "@/lib/utils"

/**
 * The Morf mark, drawn as a mask filled with `currentColor`, so it follows the text colour and
 * flips with the theme. Its aspect is the trimmed artwork's (320 × 233).
 */
export function Mark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block aspect-[320/233] bg-current", className)}
      style={{
        maskImage: `url(${markUrl})`,
        WebkitMaskImage: `url(${markUrl})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        ...style,
      }}
    />
  )
}

/** Mark + lowercase name, as in the wordmark. `size` is the text's font size in px. */
export function Wordmark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)} style={{ gap: size * 0.32 }} aria-label="Morf">
      <Mark style={{ height: size * 0.82 }} />
      <span
        aria-hidden="true"
        className="font-sans font-[500] leading-none"
        style={{ fontSize: size, letterSpacing: "-0.035em", marginTop: -size * 0.08 }}
      >
        morf
      </span>
    </span>
  )
}
