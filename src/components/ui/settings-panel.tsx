"use client"

// From chatcn, chat, voice and agent UI for shadcn: https://chatcn.dev

import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch } from "@base-ui/react/switch"
import { Tabs } from "@base-ui/react/tabs"

/** chatcn theme variables and utilities this file uses, light and dark. */
const CHATCN_CSS = ":root{--chatcn-accent:var(--chatcn-gray-1000);--chatcn-accent-fg:var(--chatcn-bg);--chatcn-alpha-500:oklch(0 0 0 / 0.14);--chatcn-alpha-600:oklch(0 0 0 / 0.2);--chatcn-bg:oklch(1 0 0);--chatcn-border:var(--chatcn-gray-400);--chatcn-card:oklch(1 0 0);--chatcn-ease-out:cubic-bezier(0.23, 1, 0.32, 1);--chatcn-ease-standard:ease;--chatcn-fg:var(--chatcn-gray-1000);--chatcn-fg-faint:var(--chatcn-gray-700);--chatcn-fg-muted:var(--chatcn-gray-900);--chatcn-fg-subtle:var(--chatcn-gray-800);--chatcn-fill:var(--chatcn-gray-100);--chatcn-fill-active:var(--chatcn-gray-300);--chatcn-fill-hover:var(--chatcn-gray-200);--chatcn-gray-100:oklch(0.970 0 0);--chatcn-gray-1000:oklch(0.145 0 0);--chatcn-gray-200:oklch(0.950 0 0);--chatcn-gray-300:oklch(0.930 0 0);--chatcn-gray-400:oklch(0.910 0 0);--chatcn-gray-700:oklch(0.700 0 0);--chatcn-gray-800:oklch(0.525 0 0);--chatcn-gray-900:oklch(0.440 0 0);--chatcn-press-scale:0.97;--chatcn-press-scale-icon:0.94;--chatcn-primary:var(--chatcn-gray-1000);--chatcn-primary-fg:var(--chatcn-bg);--chatcn-primary-hover:var(--chatcn-gray-900);--chatcn-radius-md:8px;--chatcn-radius-sm:6px;--chatcn-radius-xl:16px;--chatcn-radius-xs:4px;--chatcn-scrollbar:var(--chatcn-alpha-500);--chatcn-scrollbar-hover:var(--chatcn-alpha-600);--chatcn-shadow-sm:0 0 0 1px oklch(0 0 0 / 0.06), 0 1px 2px -1px oklch(0 0 0 / 0.06), 0 2px 4px oklch(0 0 0 / 0.04);--chatcn-shadow-xs:0 0 0 1px oklch(0 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.04)}.dark{--chatcn-accent:var(--chatcn-gray-1000);--chatcn-accent-fg:var(--chatcn-bg);--chatcn-alpha-500:oklch(1 0 0 / 0.16);--chatcn-alpha-600:oklch(1 0 0 / 0.24);--chatcn-bg:oklch(0.145 0 0);--chatcn-border:var(--chatcn-gray-400);--chatcn-card:oklch(0.175 0 0);--chatcn-fg:var(--chatcn-gray-1000);--chatcn-fg-faint:var(--chatcn-gray-700);--chatcn-fg-muted:var(--chatcn-gray-900);--chatcn-fg-subtle:var(--chatcn-gray-800);--chatcn-fill:var(--chatcn-gray-100);--chatcn-fill-active:var(--chatcn-gray-300);--chatcn-fill-hover:var(--chatcn-gray-200);--chatcn-gray-100:oklch(0.195 0 0);--chatcn-gray-1000:oklch(0.970 0 0);--chatcn-gray-200:oklch(0.225 0 0);--chatcn-gray-300:oklch(0.255 0 0);--chatcn-gray-400:oklch(0.285 0 0);--chatcn-gray-700:oklch(0.500 0 0);--chatcn-gray-800:oklch(0.620 0 0);--chatcn-gray-900:oklch(0.720 0 0);--chatcn-primary:var(--chatcn-gray-1000);--chatcn-primary-fg:var(--chatcn-bg);--chatcn-primary-hover:var(--chatcn-gray-900);--chatcn-scrollbar:var(--chatcn-alpha-500);--chatcn-scrollbar-hover:var(--chatcn-alpha-600);--chatcn-shadow-sm:0 0 0 1px oklch(1 0 0 / 0.08), inset 0 1px 0 oklch(1 0 0 / 0.03), 0 2px 4px oklch(0 0 0 / 0.4);--chatcn-shadow-xs:0 0 0 1px oklch(1 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.4)}.chatcn-focus{}.chatcn-focus:focus-visible{outline: 2px solid var(--chatcn-accent); outline-offset: 2px;}.chatcn-scroll{scrollbar-width: thin; scrollbar-color: var(--chatcn-scrollbar) transparent;}.chatcn-scroll:hover{scrollbar-color: var(--chatcn-scrollbar-hover) transparent;}.chatcn-scroll::-webkit-scrollbar{width: 10px; height: 10px;}.chatcn-scroll::-webkit-scrollbar-track, .chatcn-scroll::-webkit-scrollbar-corner{background: transparent;}.chatcn-scroll::-webkit-scrollbar-thumb{background-color: var(--chatcn-scrollbar); background-clip: content-box; border: 3px solid transparent; border-radius: 9999px;}.chatcn-scroll::-webkit-scrollbar-thumb:hover{background-color: var(--chatcn-scrollbar-hover);}@media (prefers-reduced-motion: reduce){:root{--chatcn-press-scale:1;--chatcn-press-scale-icon:1;--chatcn-enter-scale:1}}"
if (typeof document !== "undefined" && !document.getElementById("chatcn-settings-panel")) {
  const style = document.createElement("style")
  style.id = "chatcn-settings-panel"
  style.textContent = CHATCN_CSS
  document.head.appendChild(style)
}

interface SettingsRowContextValue {
  labelId: string
  descriptionId?: string
  disabled?: boolean
}

const SettingsRowContext = React.createContext<SettingsRowContextValue | null>(null)

/** Label and description ids of the nearest `SettingsRow`, so a control can name itself. */
export function useSettingsRow() {
  return React.useContext(SettingsRowContext)
}

/* -------------------------------------------------------------------------------------------------
 * Switch
 * -----------------------------------------------------------------------------------------------*/

export type SettingsSwitchProps = React.ComponentProps<typeof Switch.Root>

/**
 * An on/off control. The thumb slides 150 ms and the track fills with ink, so the state never
 * depends on color alone. Inside a `SettingsRow` it takes the row's label and description.
 */
export function SettingsSwitch({ className, disabled, ...props }: SettingsSwitchProps) {
  const row = useSettingsRow()
  return (
    <Switch.Root
      aria-labelledby={props["aria-label"] ? undefined : row?.labelId}
      aria-describedby={row?.descriptionId}
      disabled={disabled ?? row?.disabled}
      data-slot="settings-switch"
      className={cn(
        "chatcn-focus relative inline-flex h-[1.125rem] w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5",
        "bg-(color:--chatcn-fill-active) data-[checked]:bg-(color:--chatcn-accent)",
        "ease-(--chatcn-ease-standard) transition-[background-color] duration-150",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        // 44 px of hit area on touch without changing the drawing.
        "pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']",
        "forced-colors:outline-1 forced-colors:outline-solid",
        className,
      )}
      {...props}
    >
      <Switch.Thumb
        className={cn(
          "bg-(color:--chatcn-card) shadow-(--chatcn-shadow-xs) block size-3.5 rounded-full",
          "ease-(--chatcn-ease-out) transition-[translate,background-color] duration-150 motion-reduce:transition-none",
          "data-[checked]:bg-(color:--chatcn-accent-fg) data-[checked]:translate-x-3.5 rtl:data-[checked]:-translate-x-3.5",
        )}
      />
    </Switch.Root>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Segmented
 * -----------------------------------------------------------------------------------------------*/

export interface SettingsSegmentedOption {
  value: string
  label: React.ReactNode
  icon?: React.ReactNode
  /** Show only the icon; `label` becomes the accessible name. */
  iconOnly?: boolean
  disabled?: boolean
}

export interface SettingsSegmentedProps
  extends Omit<React.ComponentProps<"div">, "onChange" | "defaultValue"> {
  options: SettingsSegmentedOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  size?: "xs" | "sm"
}

/**
 * Two to four exclusive choices in one track. Native radio inputs underneath: Tab enters the
 * group, arrow keys move and select, and screen readers hear a radio group. The selection moves
 * instantly; it is changed often and from the keyboard.
 */
export function SettingsSegmented({
  options,
  value: valueProp,
  defaultValue,
  onValueChange,
  disabled: disabledProp,
  size = "sm",
  className,
  ...props
}: SettingsSegmentedProps) {
  const row = useSettingsRow()
  const disabled = disabledProp ?? row?.disabled
  const [valueState, setValueState] = React.useState(defaultValue ?? options[0]?.value ?? "")
  const value = valueProp ?? valueState
  const name = React.useId()
  return (
    <div
      role="radiogroup"
      aria-labelledby={props["aria-label"] ? undefined : row?.labelId}
      aria-describedby={row?.descriptionId}
      aria-disabled={disabled || undefined}
      data-slot="settings-segmented"
      data-size={size}
      className={cn(
        "bg-(color:--chatcn-fill) inline-flex shrink-0 items-center gap-0.5 p-0.5",
        size === "xs" ? "rounded-(--chatcn-radius-sm)" : "rounded-(--chatcn-radius-md)",
        disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <label
            key={option.value}
            data-checked={checked ? "" : undefined}
            className={cn(
              "relative inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none",
              size === "xs"
                ? "text-[0.75rem]/[1rem] rounded-(--chatcn-radius-xs) h-6 px-2 [&_svg]:size-3.5"
                : "text-[0.8125rem]/[1.25rem] rounded-(--chatcn-radius-sm) h-7 px-2.5 [&_svg]:size-4",
              option.iconOnly && (size === "xs" ? "w-6 px-0" : "w-8 px-0"),
              "text-(color:--chatcn-fg-muted) hover:text-(color:--chatcn-fg) transition-colors duration-150",
              "data-[checked]:bg-(color:--chatcn-card) data-[checked]:text-(color:--chatcn-fg) data-[checked]:shadow-(--chatcn-shadow-xs) data-[checked]:transition-none",
              "has-[:focus-visible]:outline-(color:--chatcn-accent) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1",
              "has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50",
              "pointer-coarse:min-h-11",
              "forced-colors:data-[checked]:outline-1 forced-colors:data-[checked]:outline-solid",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled || option.disabled}
              aria-label={
                option.iconOnly && typeof option.label === "string" ? option.label : undefined
              }
              onChange={() => {
                if (valueProp === undefined) setValueState(option.value)
                onValueChange?.(option.value)
              }}
              className="sr-only"
            />
            {option.icon ? (
              <span aria-hidden="true" className="grid place-items-center">
                {option.icon}
              </span>
            ) : null}
            {option.iconOnly ? null : <span>{option.label}</span>}
          </label>
        )
      })}
    </div>
  )
}

export interface SettingsRowProps extends Omit<React.ComponentProps<"div">, "title"> {
  label: React.ReactNode
  description?: React.ReactNode
  /** Put the control under the text, full width: for text areas, lists and wide pickers. */
  stacked?: boolean
  disabled?: boolean
  /** A note under the row, such as "Managed by your admin". */
  note?: React.ReactNode
}

/**
 * One setting: label and description on the start side, the control on the end side. Wraps under
 * the text when space runs out. `SettingsSwitch` and `SettingsSegmented` inside a row name
 * themselves from its label and description.
 */
export function SettingsRow({
  label,
  description,
  stacked = false,
  disabled = false,
  note,
  className,
  children,
  ...props
}: SettingsRowProps) {
  const labelId = React.useId()
  const descriptionId = React.useId()
  const value = React.useMemo(
    () => ({ labelId, descriptionId: description ? descriptionId : undefined, disabled }),
    [labelId, descriptionId, description, disabled],
  )
  return (
    <SettingsRowContext.Provider value={value}>
      <div
        data-slot="settings-row"
        data-disabled={disabled ? "" : undefined}
        className={cn(
          "flex min-h-14 flex-wrap items-center gap-x-6 gap-y-3 py-3.5",
          stacked && "flex-col items-stretch",
          className,
        )}
        {...props}
      >
        {/* Disabled rows step down the gray ramp instead of fading, so the reason stays readable. */}
        <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5">
          <span
            id={labelId}
            className={cn(
              "text-[0.875rem]/[1.25rem] tracking-[-0.003em] font-medium",
              disabled ? "text-(color:--chatcn-fg-muted)" : "text-(color:--chatcn-fg)",
            )}
          >
            {label}
          </span>
          {description ? (
            <span
              id={descriptionId}
              className={cn(
                "text-[0.8125rem]/[1.25rem] text-pretty",
                disabled ? "text-(color:--chatcn-fg-subtle)" : "text-(color:--chatcn-fg-muted)",
              )}
            >
              {description}
            </span>
          ) : null}
          {note ? <span className="text-[0.75rem]/[1rem] text-(color:--chatcn-fg-muted) pt-1">{note}</span> : null}
        </div>
        {children !== undefined && children !== null ? (
          <div
            data-slot="settings-row-control"
            className={cn("flex shrink-0 items-center gap-2", stacked && "w-full")}
          >
            {children}
          </div>
        ) : null}
      </div>
    </SettingsRowContext.Provider>
  )
}

export interface SettingsPanelProps
  extends Omit<React.ComponentProps<typeof Tabs.Root>, "value" | "defaultValue" | "onValueChange"> {
  /** The open section. Controlled. */
  value?: string
  /** The section open at first. Uncontrolled. */
  defaultValue?: string
  onValueChange?: (value: string) => void
}

/* -------------------------------------------------------------------------------------------------
 * SettingsPanel
 *
 * Layout: a sections nav and one pane. At 42 rem and wider (a container query, so it follows the
 * space it is given, not the viewport) the nav is a column on the start side. Narrower, it becomes
 * a scrolling row above the pane. Panes swap instantly: people flip between sections often.
 * -----------------------------------------------------------------------------------------------*/

/** Below this width the nav sits above the pane and arrow keys move left and right. */
const STACK_BELOW = 672

/**
 * The settings surface for an AI app: compose `SettingsNav` with `SettingsNavItem`s and one
 * `SettingsPane` per section. Give it a height (`className="h-[640px]"`) and each pane scrolls on
 * its own; without one it grows with its content.
 */
export function SettingsPanel({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: SettingsPanelProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = React.useState(false)

  // CSS decides the layout through a container query. This only keeps arrow keys in step with it.
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStacked(entry.contentRect.width < STACK_BELOW)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <Tabs.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => onValueChange?.(String(next))}
      orientation={stacked ? "horizontal" : "vertical"}
      data-slot="settings-panel"
      className={cn("text-[0.875rem]/[1.25rem] tracking-[-0.003em] text-(color:--chatcn-fg) @container/settings flex min-h-0", className)}
      {...props}
    >
      <div className="flex min-h-0 w-full min-w-0 flex-col @2xl/settings:flex-row">{children}</div>
    </Tabs.Root>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Pane
 * -----------------------------------------------------------------------------------------------*/

export interface SettingsPaneProps
  extends Omit<React.ComponentProps<typeof Tabs.Panel>, "value" | "title"> {
  value: string
  title?: React.ReactNode
  description?: React.ReactNode
  /** Controls on the end side of the header, such as a Save button or a Learn more link. */
  actions?: React.ReactNode
  /** Classes for the inner column that holds the header and groups. */
  contentClassName?: string
}

export function SettingsPane({
  value,
  title,
  description,
  actions,
  className,
  contentClassName,
  children,
  ...props
}: SettingsPaneProps) {
  return (
    <Tabs.Panel
      value={value}
      data-slot="settings-pane"
      className={cn(
        "chatcn-scroll min-h-0 min-w-0 flex-1 overflow-y-auto outline-none",
        "focus-visible:outline-(color:--chatcn-accent) focus-visible:outline-2 focus-visible:-outline-offset-2",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-5 pb-8 @2xl/settings:px-8 @2xl/settings:pt-7 @2xl/settings:pb-10",
          contentClassName,
        )}
      >
        {title || description || actions ? (
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {title ? (
                <h2 className="text-[1.25rem]/[1.75rem] tracking-[-0.018em] text-(color:--chatcn-fg) font-medium tracking-[-0.01em] text-balance">
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="text-[0.8125rem]/[1.25rem] text-(color:--chatcn-fg-muted) max-w-prose text-pretty">
                  {description}
                </p>
              ) : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
        ) : null}
        {children}
      </div>
    </Tabs.Panel>
  )
}

/** A hairline between groups of sections in the column layout. Hidden in the row layout. */
export function SettingsNavSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="presentation"
      data-slot="settings-nav-separator"
      className={cn("bg-(color:--chatcn-border) mx-2 my-2 hidden h-px @2xl/settings:block", className)}
      {...props}
    />
  )
}

export interface SettingsNavItemProps extends Omit<React.ComponentProps<typeof Tabs.Tab>, "value"> {
  value: string
  icon?: React.ReactNode
  /** A short fact after the label: a count, or "Off". Tabular. */
  meta?: React.ReactNode
}

export function SettingsNavItem({
  value,
  icon,
  meta,
  className,
  children,
  ...props
}: SettingsNavItemProps) {
  return (
    <Tabs.Tab
      value={value}
      data-slot="settings-nav-item"
      className={cn(
        "group/nav-item chatcn-focus rounded-(--chatcn-radius-md) flex h-8 shrink-0 items-center gap-2.5 px-2.5 text-start whitespace-nowrap select-none",
        "text-[0.8125rem]/[1.25rem] text-(color:--chatcn-fg-muted) @2xl/settings:text-[0.875rem]/[1.25rem] @2xl/settings:tracking-[-0.003em] @2xl/settings:px-2",
        // Frequent and keyboard driven: color only, no movement, no transition on the active fill.
        "hover:bg-(color:--chatcn-fill-hover) hover:text-(color:--chatcn-fg) transition-colors duration-150",
        "data-[active]:bg-(color:--chatcn-fill) data-[active]:text-(color:--chatcn-fg) data-[active]:transition-none",
        "disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "text-(color:--chatcn-fg-subtle) grid size-4 shrink-0 place-items-center [&_svg]:size-4",
            "group-hover/nav-item:text-(color:--chatcn-fg-muted) group-data-[active]/nav-item:text-(color:--chatcn-fg)",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta !== undefined && meta !== null ? (
        <span className="text-[0.75rem]/[1rem] text-(color:--chatcn-fg-subtle) hidden shrink-0 tabular-nums @2xl/settings:inline">
          {meta}
        </span>
      ) : null}
    </Tabs.Tab>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Nav
 * -----------------------------------------------------------------------------------------------*/

export interface SettingsNavProps extends Omit<React.ComponentProps<"nav">, "title"> {
  /** Heading above the sections, usually "Settings". */
  title?: React.ReactNode
  /** Content pinned under the sections in the column layout: a plan summary or a sign out. */
  footer?: React.ReactNode
  /** Accessible name of the section list. Default "Settings sections". */
  label?: string
}

export function SettingsNav({
  title,
  footer,
  label = "Settings sections",
  className,
  children,
  ...props
}: SettingsNavProps) {
  // On a narrow pane the sections scroll sideways; an edge fades only while more hides past it.
  const listRef = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ start: false, end: false })
  const measure = React.useCallback(() => {
    const list = listRef.current
    if (!list) return
    const row = getComputedStyle(list).overflowX === "auto"
    // scrollLeft is negative in right-to-left layouts.
    const pos = Math.abs(list.scrollLeft)
    const next = {
      start: row && pos > 1,
      end: row && pos + list.clientWidth < list.scrollWidth - 1,
    }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [measure])

  return (
    <nav
      aria-label={label}
      data-slot="settings-nav"
      className={cn(
        "border-(color:--chatcn-border) flex shrink-0 flex-col border-b",
        "@2xl/settings:w-56 @2xl/settings:border-e @2xl/settings:border-b-0",
        className,
      )}
      {...props}
    >
      {title ? (
        <h2 className="text-[0.9375rem]/[1.5rem] tracking-[-0.006em] text-(color:--chatcn-fg) px-4 pt-4 pb-1 font-medium tracking-[-0.005em] @2xl/settings:px-5 @2xl/settings:pt-5 @2xl/settings:pb-3">
          {title}
        </h2>
      ) : null}
      <Tabs.List
        ref={listRef}
        onScroll={measure}
        data-slot="settings-nav-list"
        data-scroll-start={edges.start ? "" : undefined}
        data-scroll-end={edges.end ? "" : undefined}
        className={cn(
          // Row: scrolls sideways with the edge padding kept inside the scroller.
          "relative flex [scrollbar-width:none] gap-1 overflow-x-auto px-3 py-2 [&::-webkit-scrollbar]:hidden",
          "[--fade-end:0px] [--fade-start:0px] data-[scroll-end]:[--fade-end:32px] data-[scroll-start]:[--fade-start:32px]",
          "[mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%-var(--fade-end)),transparent)]",
          "rtl:[mask-image:linear-gradient(to_left,transparent,black_var(--fade-start),black_calc(100%-var(--fade-end)),transparent)]",
          "@2xl/settings:[mask-image:none]",
          "@2xl/settings:flex-col @2xl/settings:gap-px @2xl/settings:overflow-x-visible @2xl/settings:px-3 @2xl/settings:py-0",
        )}
      >
        {children}
      </Tabs.List>
      {footer ? (
        <div
          data-slot="settings-nav-footer"
          className="mt-auto hidden px-3 pt-3 pb-3 @2xl/settings:block"
        >
          {footer}
        </div>
      ) : null}
    </nav>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Group and row
 * -----------------------------------------------------------------------------------------------*/

export interface SettingsGroupProps extends Omit<React.ComponentProps<"section">, "title"> {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Something on the end side of the group heading, such as a Reset button. */
  action?: React.ReactNode
}

/**
 * A titled set of rows separated by hairlines. No card: the panel is already a surface, and
 * hairlines plus space carry the hierarchy.
 */
export function SettingsGroup({
  title,
  description,
  action,
  className,
  children,
  ...props
}: SettingsGroupProps) {
  const id = React.useId()
  return (
    <section
      data-slot="settings-group"
      aria-labelledby={title ? id : undefined}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      {title || action ? (
        <div className="flex min-h-7 items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? (
              <h3 id={id} className="text-[0.8125rem]/[1.25rem] text-(color:--chatcn-fg) font-medium">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p className="text-[0.75rem]/[1rem] text-(color:--chatcn-fg-subtle) text-pretty">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      <div
        data-slot="settings-group-rows"
        className="divide-(color:--chatcn-border) border-(color:--chatcn-border) flex flex-col divide-y border-t"
      >
        {children}
      </div>
    </section>
  )
}

export default SettingsPanel
