import { getTool, type ToolId } from "@/lib/tools"

export function SoonScreen({ id, onBack }: { id: ToolId; onBack: () => void }) {
  const tool = getTool(id)
  return (
    <main className="flex h-full min-h-0 flex-col justify-between px-5 pt-7 pb-8">
      <h1 className="display anim-rise text-[clamp(64px,8.5vw,136px)]">{tool.name}</h1>
      <div className="anim-fade flex max-w-xl flex-col gap-4">
        <p className="label text-ink-4">In the works</p>
        <p className="text-[28px]/[36px] tracking-[-0.025em] text-ink-2">{tool.blurb}</p>
        <button onClick={onBack} className="label focus-ring w-fit text-ink transition-opacity hover:opacity-60">
          ← Back to the index
        </button>
      </div>
    </main>
  )
}
