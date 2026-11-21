/**
 * Files handed to a tool that reads drops on its own screen (PDF, Read…), for when they arrive
 * before the screen is open: dropped on the index, or sent from the right-click menu.
 */
import type { ToolId } from "./tools"

const waiting = new Map<ToolId, string[]>()

export function handOff(tool: ToolId, paths: string[]) {
  waiting.set(tool, [...(waiting.get(tool) ?? []), ...paths])
}

/** The files waiting for `tool`, once. */
export function takeHandoff(tool: ToolId): string[] {
  const p = waiting.get(tool) ?? []
  waiting.delete(tool)
  return p
}
