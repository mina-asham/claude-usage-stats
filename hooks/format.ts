import type { UsageSnapshot, UsageWindow } from '../types'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The usage endpoint's window keys: `five_hour`, `seven_day`, `seven_day_<model>`. */
const WINDOW_KEY = /^(five_hour|seven_day(_[a-z0-9]+)*)$/

export type Severity = 'ok' | 'warn' | 'high'

export function labelOf(kind: string, label?: string): string {
  if (label !== undefined && kind.startsWith('seven_day_')) return `Week · ${label}`

  if (kind === 'five_hour') return 'Session'
  if (kind === 'seven_day') return 'Week'
  if (kind === 'spend_limit') return 'Spend'

  const model = /^seven_day_(.+)$/.exec(kind)?.[1]
  if (model !== undefined) return `Week · ${capitalize(model.replace(/_/g, ' '))}`

  return capitalize(kind.replace(/_/g, ' '))
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function isCore(kind: string): boolean {
  return kind === 'five_hour' || kind === 'seven_day'
}

function rankOf(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  if (kind.startsWith('seven_day_')) return 2

  return 3
}

export function sortWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return [...windows].sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.kind.localeCompare(b.kind))
}

/** The session and the week always; a per-model or other window once it has something in it. */
export function isWorthShowing(window: UsageWindow): boolean {
  return isCore(window.kind) || window.percentUsed > 0
}

export function resetTimeOf(window: UsageWindow): number | undefined {
  if (window.resetsAt === undefined) return undefined
  const at = Date.parse(window.resetsAt)

  return Number.isFinite(at) ? at : undefined
}

/** A window whose reset time has come and gone since it was read: its figure is stale. */
export function hasLapsed(window: UsageWindow, observedAt: number, now: number): boolean {
  const at = resetTimeOf(window)

  return at !== undefined && at <= now && (window.readAt ?? observedAt) < at
}

/** Stamps a fresh window with when it was read; a figure read after its own reset time predates that reset. */
function stamped(window: UsageWindow, readAt: number, before: UsageWindow | undefined): UsageWindow {
  const beforeReset = before === undefined ? undefined : resetTimeOf(before)
  const resetsAt =
    window.resetsAt ?? (beforeReset !== undefined && beforeReset > readAt ? before?.resetsAt : undefined)
  const label = window.label ?? before?.label
  const at = resetsAt === undefined ? undefined : Date.parse(resetsAt)
  const figureAt = at !== undefined && Number.isFinite(at) && at <= readAt ? at - 1 : readAt

  return {
    kind: window.kind,
    percentUsed: window.percentUsed,
    ...(label !== undefined ? { label } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    readAt: figureAt,
  }
}

/**
 * Folds a new reading into the last one, window by window, the newer figure of
 * each window winning. An endpoint reading is the account's whole picture, so a
 * window it no longer lists goes; a response's headers carry only the session
 * and the week, so the endpoint's per-model weeks stay beside them, each with
 * the time it was really read.
 */
export function mergeSnapshot(
  previous: UsageSnapshot | null,
  windows: readonly UsageWindow[],
  source: UsageSnapshot['source'],
  readAt: number,
): UsageSnapshot {
  const before = new Map<string, UsageWindow>()
  for (const window of previous?.windows ?? []) {
    before.set(window.kind, { ...window, readAt: window.readAt ?? previous?.observedAt ?? readAt })
  }

  const byKind = new Map<string, UsageWindow>(source === 'api' ? [] : before)
  for (const window of windows) {
    const old = before.get(window.kind)
    const fresh = stamped(window, readAt, old)
    byKind.set(window.kind, old !== undefined && (old.readAt ?? 0) > (fresh.readAt ?? 0) ? old : fresh)
  }

  return {
    windows: sortWindows([...byKind.values()]),
    observedAt: Math.max(readAt, previous?.observedAt ?? 0),
    source,
  }
}

function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** One decimal, rounded down as Claude Code's /usage rounds: 99.96 is not yet 100. */
function percentOf(value: number): number {
  return Math.floor(value * 10) / 10
}

/**
 * The endpoint's `limits[]` rows (newer servers): `session`, `weekly_all` and
 * `weekly_scoped` meters, the last named by the model or surface they cover.
 */
function parseLimits(rows: readonly unknown[]): UsageWindow[] {
  const windows: UsageWindow[] = []

  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const { kind, percent, resets_at: resetsAt, scope } = row as {
      kind?: unknown
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown } | null; surface?: { display_name?: unknown } | null } | null
    }
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue

    const scoped = scope?.model?.display_name ?? scope?.surface?.display_name
    const label = typeof scoped === 'string' && scoped.trim() !== '' ? scoped.trim() : undefined
    const key =
      kind === 'session'
        ? 'five_hour'
        : kind === 'weekly_all'
          ? 'seven_day'
          : kind === 'weekly_scoped' && label !== undefined
            ? `seven_day_${slugOf(label)}`
            : undefined
    if (key === undefined || windows.some(w => w.kind === key)) continue

    windows.push({
      kind: key,
      percentUsed: percentOf(percent),
      ...(typeof resetsAt === 'string' ? { resetsAt } : {}),
      ...(key.startsWith('seven_day_') && label !== undefined ? { label } : {}),
    })
  }

  return windows
}

/** The `five_hour` / `seven_day[_<model>]` objects every server sends, a window null when it does not apply. */
function parseLegacy(body: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = []

  for (const [kind, value] of Object.entries(body)) {
    if (!WINDOW_KEY.test(kind) || kind === 'seven_day_oauth_apps') continue
    if (value === null || typeof value !== 'object') continue

    const { utilization, resets_at: resetsAt } = value as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue

    windows.push({
      kind,
      percentUsed: percentOf(utilization),
      ...(typeof resetsAt === 'string' ? { resetsAt } : {}),
    })
  }

  return windows
}

/**
 * The usage endpoint's answer as windows. Where it sends `limits[]` rows, they
 * name the meters (the per-model weeks among them), the older fields filling
 * in a session or week the rows leave out; else the older fields alone.
 * Anything it does not recognise is left out.
 */
export function parseUsage(body: unknown): UsageWindow[] {
  if (body === null || typeof body !== 'object') return []

  const legacy = parseLegacy(body as Record<string, unknown>)
  const { limits } = body as { limits?: unknown }
  const fromLimits = Array.isArray(limits) ? parseLimits(limits) : []
  if (fromLimits.length === 0) return sortWindows(legacy)

  const byKind = new Map<string, UsageWindow>()
  for (const window of legacy) if (isCore(window.kind)) byKind.set(window.kind, window)
  for (const window of fromLimits) byKind.set(window.kind, window)

  return sortWindows([...byKind.values()])
}

/** A body the endpoint answers in place of usage when it is throttling the caller, with a 200. */
export function isRateLimitEnvelope(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const { error } = body as { error?: unknown }

  return typeof error === 'object' && error !== null && (error as { type?: unknown }).type === 'rate_limit_error'
}

export function isSnapshot(value: unknown): value is UsageSnapshot {
  if (value === null || typeof value !== 'object') return false
  const { windows, observedAt, source } = value as Partial<UsageSnapshot>

  return (
    Array.isArray(windows) &&
    windows.every(w => typeof w?.kind === 'string' && typeof w?.percentUsed === 'number') &&
    typeof observedAt === 'number' &&
    (source === 'session' || source === 'api')
  )
}

export function severityOf(percent: number): Severity {
  if (percent >= 90) return 'high'
  if (percent >= 70) return 'warn'

  return 'ok'
}

/** Whole percent, rounded down as Claude Code's /usage shows it. */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%'

  return `${Math.floor(percent)}%`
}

/** `45m`, `2h 5m`, `3d 4h`: how long until `ms` from now has passed, rounded up to the minute. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / MINUTE)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`

  const days = Math.floor(hours / 24)

  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

// Built once: a band draws every few seconds and lays out several forms each time.
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** `4:20 PM` today, `Thu 9:00 AM` within the week, `Oct 17 9:00 AM` past it; in local time. */
export function formatResetTime(at: number, now: number): string {
  const date = new Date(at)
  const time = TIME.format(date)
  if (new Date(now).toDateString() === date.toDateString()) return time

  if (at - now < 6 * DAY) return `${WEEKDAY.format(date)} ${time}`

  return `${MONTH_DAY.format(date)} ${time}`
}

/** What follows a window's figure: when it resets and how long that is from now. */
export function describeReset(window: UsageWindow, observedAt: number, now: number): string {
  const at = resetTimeOf(window)
  if (at === undefined) return ''
  if (hasLapsed(window, observedAt, now)) return `reset at ${formatResetTime(at, now)}`

  return `resets ${formatResetTime(at, now)} · in ${formatCountdown(at - now)}`
}

/** The windows as plain lines: the command's answer. */
export function summaryLines(snapshot: UsageSnapshot | null, now: number): string[] {
  const shown = (snapshot?.windows ?? []).filter(isWorthShowing)
  if (snapshot === null || shown.length === 0) return []

  return shown.map(window => {
    const lapsed = hasLapsed(window, snapshot.observedAt, now)
    const figure = lapsed ? 'no reading since it reset' : `${formatPercent(window.percentUsed)} used`
    const reset = describeReset(window, snapshot.observedAt, now)

    return `${labelOf(window.kind, window.label)}: ${figure}${reset ? ` · ${reset}` : ''}`
  })
}

/** Ten cells of block characters, at least one filled once anything is used. */
export function textBar(percent: number, cells = 10): { filled: string; empty: string } {
  const exact = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  const count = percent > 0 ? Math.max(1, exact) : 0

  return { filled: '█'.repeat(count), empty: '░'.repeat(cells - count) }
}

const SVG_FILL: Record<Severity, string> = { ok: '#2f9e6b', warn: '#d4a72c', high: '#e5484d' }

/** A rounded meter for the surfaces that draw SVG, in colours that read on light and dark alike. */
export function svgBar(percent: number, width = 72, height = 6): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = percent > 0 ? Math.max(height, Math.round((clamped / 100) * width)) : 0
  const radius = height / 2
  const fill = SVG_FILL[severityOf(percent)]
  const track = `<rect width="${width}" height="${height}" rx="${radius}" fill="#8080804d"/>`
  const bar = filled > 0 ? `<rect width="${filled}" height="${height}" rx="${radius}" fill="${fill}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${track}${bar}</svg>`
}

/** How long ago, for a reading that has gone stale: `12m ago`, `3h ago`. */
export function formatAge(ms: number): string {
  if (ms < MINUTE) return 'just now'

  return `${formatCountdown(ms)} ago`
}

/**
 * The read time of a figure whose age is unknown: the session's own reading at
 * start, which Claude Code may carry over from an earlier process. Older than
 * any timestamped reading, so any of those wins over it.
 */
export const UNKNOWN_READ_AT = 1

/** Whether a snapshot's newest reading has a known time. */
export function isAgeKnown(snapshot: UsageSnapshot): boolean {
  return snapshot.observedAt > UNKNOWN_READ_AT
}

/** Cells a meter takes on the line: ten block characters, or a 72 px SVG at about 7 px a cell. */
export const METER_CELLS = 10
/** Cells between two windows on the line. */
export const ITEM_GAP = 3

/**
 * How a window's reset reads, from the most to the least room:
 * `resets 4:20 PM (1h 52m)`, `resets in 1h 52m`, `1h 52m`, nothing.
 */
export type ResetForm = 'clock' | 'countdown' | 'bare' | 'none'

/** One window as the one-line band draws it. */
export type LineItem = {
  kind: string
  label: string
  /** `38%`, or `—` once the window has reset since it was read. */
  figure: string
  /** What the meter shows: 0 once the window has reset. */
  meter: number
  severity: Severity
  isLapsed: boolean
  /** The reset in the plan's form; `''` without a reset time. */
  reset: string
  /** Cells the countdown may still grow by (`2h 9m` to `4h 59m`), counted so the form holds as the minutes pass. */
  slack: number
}

export type LinePlan = { items: LineItem[]; hasMeters: boolean; width: number }

function lineItemOf(window: UsageWindow, observedAt: number, now: number, form: ResetForm): LineItem {
  const isLapsed = hasLapsed(window, observedAt, now)
  const at = resetTimeOf(window)
  const countdown = at === undefined || isLapsed ? '' : formatCountdown(at - now)
  const longest = window.kind === 'five_hour' ? '4h 59m'.length : '23h 59m'.length

  let reset = ''
  if (at !== undefined && form !== 'none') {
    if (isLapsed) {
      reset = form === 'clock' ? `reset ${formatResetTime(at, now)}` : form === 'countdown' ? 'reset' : ''
    } else if (form === 'clock') {
      reset = `resets ${formatResetTime(at, now)} (${countdown})`
    } else if (form === 'countdown') {
      reset = `resets in ${countdown}`
    } else {
      reset = countdown
    }
  }

  return {
    kind: window.kind,
    label: labelOf(window.kind, window.label),
    figure: isLapsed ? '—' : formatPercent(window.percentUsed),
    meter: isLapsed ? 0 : window.percentUsed,
    severity: severityOf(window.percentUsed),
    isLapsed,
    reset,
    slack: reset !== '' && countdown !== '' ? Math.max(0, longest - countdown.length) : 0,
  }
}

function widthOf(items: readonly LineItem[], hasMeters: boolean): number {
  const cells = items.reduce(
    (sum, item) =>
      sum +
      item.label.length +
      1 +
      (hasMeters ? METER_CELLS + 1 : 0) +
      item.figure.length +
      (item.reset === '' ? 0 : 1 + item.reset.length + item.slack),
    0,
  )

  return cells + ITEM_GAP * Math.max(0, items.length - 1)
}

/**
 * Lays the windows out on one line of `columns` cells, giving things up in
 * order until it fits: the per-model weeks, the meters, the clock times, the
 * words around the countdowns, the countdowns. The figures go last: the
 * barest form is returned whatever its width, and the band clips it. Widths
 * count each countdown at its longest, so the form holds as the minutes pass.
 */
export function planLine(snapshot: UsageSnapshot, now: number, columns: number): LinePlan {
  const shown = snapshot.windows
    .filter(isWorthShowing)
    .filter(w => isCore(w.kind) || !hasLapsed(w, snapshot.observedAt, now))
  const core = shown.filter(w => isCore(w.kind))
  const base = core.length > 0 ? core : shown
  const attempts: { windows: UsageWindow[]; hasMeters: boolean; form: ResetForm }[] = [
    { windows: shown, hasMeters: true, form: 'clock' },
    { windows: base, hasMeters: true, form: 'clock' },
    { windows: base, hasMeters: false, form: 'clock' },
    { windows: base, hasMeters: false, form: 'countdown' },
    { windows: base, hasMeters: false, form: 'bare' },
    { windows: base, hasMeters: false, form: 'none' },
  ]

  let plan: LinePlan = { items: [], hasMeters: false, width: 0 }
  for (const attempt of attempts) {
    const items = attempt.windows.map(w => lineItemOf(w, snapshot.observedAt, now, attempt.form))
    plan = { items, hasMeters: attempt.hasMeters, width: widthOf(items, attempt.hasMeters) }
    if (plan.width <= columns) return plan
  }

  return plan
}
