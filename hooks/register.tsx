import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot, UsageWindow } from '../types'
import {
  ITEM_GAP,
  UNKNOWN_READ_AT,
  formatAge,
  formatCountdown,
  isAgeKnown,
  isRateLimitEnvelope,
  isSnapshot,
  mergeSnapshot,
  parseUsage,
  planLine,
  summaryLines,
  svgBar,
  textBar,
} from './format'

const COMMAND = 'usage-stats'
/** The account's plan usage, as Claude Code's own /usage reads it. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** How often the band redraws and looks at the shared reading. */
const REFRESH_MS = 3_000
/**
 * How often the endpoint is asked, by every session together. Measured on
 * 2026-10-10: it lets about one request through every two minutes (after a
 * burst of a few), counting every caller on the login, Claude Code's own
 * /usage included; three minutes leaves room for those. Each reply's own
 * reading reaches the band at once in between (session.measure).
 */
const POLL_MS = 3 * 60_000
/** How long a session holds the turn to ask before another may take it over; a request gives up at 30 s. */
const CLAIM_MS = 45_000
/** After a 5xx, a network failure or an unreadable answer. */
const FAILED_MS = 2 * 60_000
/** After a throttle (429, a bare 403, a rate-limit body) that names no Retry-After, as Claude Code waits. */
const THROTTLED_MS = 5 * 60_000
/** After a refused login or a missing endpoint, as Claude Code waits after a refused login. */
const LONG_MS = 60 * 60_000
const STALE_MS = 10 * 60_000

const snapshot = atom({ plugin: 'usage-stats', key: 'snapshot' } as const, null)
const now = atom({ plugin: 'usage-stats', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-stats', key: 'isHidden' } as const, false)
const error = atom({ plugin: 'usage-stats', key: 'error' } as const, null)

const COLOR = { ok: 'success', warn: 'warning', high: 'error' } as const

/** Why the endpoint is not being asked yet. */
type Wait = 'answered' | 'asking' | 'throttled' | 'refused' | 'failed' | 'unavailable'

/**
 * The endpoint's turn, shared by every session through one file: when it may
 * next be asked, the last answer any session got, and the last refusal.
 */
type Shared = {
  nextAt: number
  wait: Wait
  claimedBy?: string
  answer?: { at: number; windows: UsageWindow[] }
  error?: string
}

type Fetched = { windows: UsageWindow[] } | { error: string; wait: Exclude<Wait, 'answered' | 'asking'>; waitMs: number }

type Trigger = 'start' | 'tick' | 'command'

/** One request to the endpoint, as `/usage-stats debug` lists it: never the credential, only what came back. */
type RequestRecord = {
  sentAt: number
  trigger: Trigger
  ms: number
  status: number | string
  headers: Record<string, string>
  body?: string
}

/** The response headers worth keeping: throttling, tracing and caching; never a cookie. */
const KEPT_HEADER = /ratelimit|retry-after|request-id|^server$|^cf-ray$|^via$|^age$/i
const MAX_RECORDS = 40

/** This module's name in the shared file's claim. */
const SESSION = Math.random().toString(36).slice(2, 10)

/** The requests this session sent, newest last. A reload starts it over. */
const requests: RequestRecord[] = []
/** The shared turn where no file can hold it (no home directory): this session alone. */
let unshared: Shared | null = null
/** The newest shared answer this session has taken in. */
let adoptedAt = 0
/** A request is out: the next tick skips rather than piling one on. A reload drops it with the old module. */
let isInFlight = false

async function apply($: EngineInterface, windows: readonly UsageWindow[], source: UsageSnapshot['source'], readAt: number) {
  const before = await read($, snapshot)
  const merged = await update($, snapshot, previous => mergeSnapshot(previous, windows, source, readAt))
  if (merged !== null && (before === null || JSON.stringify(before.windows) !== JSON.stringify(merged.windows))) {
    await $.store.set('snapshot', merged)
  }
}

async function setError($: EngineInterface, text: string | null): Promise<void> {
  if ((await read($, error)) !== text) await update($, error, () => text)
}

async function sharedPath($: EngineInterface): Promise<string | undefined> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return `${configDir}/usage-stats/endpoint.json`
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/usage-stats/endpoint.json` : undefined
}

function isShared(value: unknown): value is Shared {
  if (value === null || typeof value !== 'object') return false
  const { nextAt, wait, answer } = value as Partial<Shared>

  return (
    typeof nextAt === 'number' &&
    typeof wait === 'string' &&
    (answer === undefined || (typeof answer.at === 'number' && Array.isArray(answer.windows)))
  )
}

async function load($: EngineInterface, path: string | undefined): Promise<Shared | null> {
  if (path === undefined) return unshared
  try {
    const parsed: unknown = JSON.parse(String(await $.fs.read(path)))

    return isShared(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function save($: EngineInterface, path: string | undefined, shared: Shared): Promise<void> {
  if (path === undefined) {
    unshared = shared

    return
  }
  try {
    await $.fs.write(path, `${JSON.stringify(shared)}\n`)
  } catch {
    unshared = shared
  }
}

function retryAfterOf(header: string | undefined, at: number): number {
  if (header === undefined) return THROTTLED_MS
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - at

  return Number.isFinite(ms) && ms > 0 ? Math.min(LONG_MS, Math.max(REFRESH_MS, ms)) : THROTTLED_MS
}

function errorTypeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { error: inner } = body as { error?: unknown }
  if (inner === null || typeof inner !== 'object') return undefined
  const { type } = inner as { type?: unknown }

  return typeof type === 'string' ? type : undefined
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function fetchUsage($: EngineInterface, trigger: Trigger): Promise<Fetched> {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') {
    return { error: 'plan usage needs a Claude subscription login', wait: 'refused', waitMs: THROTTLED_MS }
  }

  const sentAt = await $.clock.now()
  const remember = (entry: Omit<RequestRecord, 'sentAt' | 'trigger'>) => {
    requests.push({ sentAt, trigger, ...entry })
    if (requests.length > MAX_RECORDS) requests.splice(0, requests.length - MAX_RECORDS)
  }
  let response
  try {
    response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    })
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown)
    remember({ ms: (await $.clock.now()) - sentAt, status: `failed: ${reason.slice(0, 200)}`, headers: {} })

    return { error: `could not reach the usage endpoint: ${reason.slice(0, 120)}`, wait: 'failed', waitMs: FAILED_MS }
  }

  const answeredAt = await $.clock.now()
  const { status } = response
  const body = parseBody(response.text)
  remember({
    ms: answeredAt - sentAt,
    status,
    headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => KEPT_HEADER.test(name))),
    ...(response.ok ? {} : { body: response.text.slice(0, 400) }),
  })

  // Sorted as Claude Code sorts this endpoint's answers.
  const errorType = errorTypeOf(body)
  const retryAfterMs = retryAfterOf(response.headers['retry-after'], answeredAt)
  if (status === 429 || errorType === 'rate_limit_error' || (status === 403 && errorType === undefined)) {
    return { error: 'the usage endpoint is rate limiting', wait: 'throttled', waitMs: retryAfterMs }
  }
  if (status === 401 || status === 403) {
    return { error: 'the usage endpoint refused the login', wait: 'refused', waitMs: LONG_MS }
  }
  if (status === 404) {
    return { error: 'the usage endpoint is not available', wait: 'unavailable', waitMs: LONG_MS }
  }
  if (!response.ok) {
    return { error: `the usage endpoint answered ${status}`, wait: 'failed', waitMs: FAILED_MS }
  }
  if (body === undefined) {
    return { error: 'the usage endpoint answered with something unreadable', wait: 'failed', waitMs: FAILED_MS }
  }

  const windows = parseUsage(body)

  return windows.length > 0
    ? { windows }
    : { error: 'the usage endpoint listed no windows', wait: 'failed', waitMs: FAILED_MS }
}

/**
 * Takes in the newest shared answer, then asks the endpoint if it is this
 * session's turn: the shared wait is over and its claim holds.
 */
async function refresh($: EngineInterface, trigger: Trigger): Promise<void> {
  if (isInFlight) return
  isInFlight = true
  try {
    const path = await sharedPath($)
    const shared = await load($, path)
    if (shared?.answer !== undefined && shared.answer.at > adoptedAt) {
      adoptedAt = shared.answer.at
      await apply($, shared.answer.windows, 'api', shared.answer.at)
    }
    await setError($, shared?.error ?? null)

    const at = await $.clock.now()
    if (shared !== null && at < shared.nextAt) return

    // One session asks for all: claim the turn, and go only if the claim held.
    const base: Shared = shared ?? { nextAt: 0, wait: 'answered' }
    await save($, path, { ...base, nextAt: at + CLAIM_MS, wait: 'asking', claimedBy: SESSION })
    if ((await load($, path))?.claimedBy !== SESSION) return

    const fetched = await fetchUsage($, trigger)
    const doneAt = await $.clock.now()
    if ('windows' in fetched) {
      adoptedAt = at
      await apply($, fetched.windows, 'api', at)
      await setError($, null)
      await save($, path, { nextAt: doneAt + POLL_MS, wait: 'answered', answer: { at, windows: fetched.windows } })

      return
    }

    await setError($, fetched.error)
    await save($, path, {
      nextAt: doneAt + fetched.waitMs,
      wait: fetched.wait,
      ...(base.answer !== undefined ? { answer: base.answer } : {}),
      error: fetched.error,
    })
  } finally {
    isInFlight = false
  }
}

async function tick($: EngineInterface, trigger: Trigger): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!(await read($, isHidden))) await refresh($, trigger)
}

/** When the endpoint was last read and when it is next due, for the command. */
async function describeTurn($: EngineInterface, at: number): Promise<string> {
  const shared = await load($, await sharedPath($))
  if (shared === null) return ''
  const parts: string[] = []
  if (shared.answer !== undefined) parts.push(`usage endpoint read ${formatAge(at - shared.answer.at)}`)
  if (shared.error !== undefined) parts.push(shared.error)
  if (shared.nextAt > at) parts.push(`next read in ${formatCountdown(shared.nextAt - at)}`)

  return parts.length > 0 ? `(${parts.join('; ')})` : ''
}

async function describeRequests($: EngineInterface, at: number): Promise<string> {
  const shared = await load($, await sharedPath($))
  const turn =
    shared === null
      ? 'Shared turn: none yet.'
      : `Shared turn: ${shared.wait}${shared.claimedBy ? ` (claimed by ${shared.claimedBy === SESSION ? 'this session' : 'another session'})` : ''}, next read ${shared.nextAt > at ? `in ${formatCountdown(shared.nextAt - at)}` : 'due now'}.`
  if (requests.length === 0) return `${turn}\nThis session has sent no requests to the usage endpoint since it loaded.`
  const lines = requests.map(entry => {
    const headers = Object.entries(entry.headers)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ')

    return `${formatAge(at - entry.sentAt)}  ${entry.trigger}  ${entry.status}  ${entry.ms}ms${headers ? `  ${headers}` : ''}${entry.body ? `  body: ${entry.body.slice(0, 160)}` : ''}`
  })

  return [turn, `Requests this session sent (${requests.length}, oldest first):`, ...lines].join('\n')
}

async function setHidden($: EngineInterface, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden)
  await $.store.set('isHidden', hidden)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show plan usage: this session (5h) and this week, with reset times',
      argumentHint: '[show|hide|debug]',
    })

    const storedHidden = await $.store.get('isHidden')
    if (typeof storedHidden === 'boolean') await update($, isHidden, () => storedHidden)

    // A reload keeps the session's snapshot; only a fresh start takes the stored one, and the session's own
    // figures. Those may be carried over from an earlier process, of unknown age: any timestamped reading wins.
    if ((await read($, snapshot)) === null) {
      const live = await $.session.usage()
      const stored = await $.store.get('snapshot')
      if (isSnapshot(stored)) await update($, snapshot, () => stored)
      if (live.rateLimits.length > 0) await apply($, live.rateLimits, 'session', UNKNOWN_READ_AT)
    }

    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    $.clock.every(REFRESH_MS, () => void tick($, 'tick'))
    // Off the start path: the first prompt never waits on the network.
    $.clock.after(1, () => void tick($, 'start'))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await apply($, e.rateLimits, 'session', await $.clock.now())
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'hide' || verb === 'show') {
      await setHidden($, verb === 'hide')

      return {
        text:
          verb === 'hide'
            ? 'Usage band hidden. `/usage-stats show` brings it back.'
            : 'Usage band shown above the prompt.',
      }
    }
    if (verb === 'debug') return { text: await describeRequests($, await $.clock.now()) }

    // Never ahead of the shared turn: this asks only when a read is due anyway.
    await refresh($, 'command')
    const at = await $.clock.now()
    const lines = summaryLines(await read($, snapshot), at)
    const turn = await describeTurn($, at)
    if (lines.length === 0) return { text: `No plan usage reading yet.${turn ? ` ${turn}` : ''}` }

    return { text: [...lines, ...(turn ? [turn] : [])].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const last = await read($, snapshot)
    const ticked = await read($, now)
    const at = ticked > 0 ? ticked : await $.clock.now()
    const problem = await read($, error)

    const { Box, Text } = $.ui.resolve(e)
    // Every table carries every element name (a surface's missing ones draw nothing), so ask the surface.
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const columns = e.props.bodyColumns

    if (last === null || last.windows.length === 0) {
      return (
        <Text dimColor wrap="truncate-end">
          {problem ? `Plan usage unavailable: ${problem}` : 'Plan usage: waiting for the first reading…'}
        </Text>
      )
    }

    // The age marker takes its room first: a figure that has gone stale is never drawn as current.
    const age = at - last.observedAt
    const stale = !isAgeKnown(last) ? 'age unknown' : age >= STALE_MS ? `updated ${formatAge(age)}` : ''
    const roomy = stale === '' ? null : planLine(last, at, columns - ITEM_GAP - stale.length)
    const hasStale = roomy !== null && roomy.width <= columns - ITEM_GAP - stale.length
    const plan = hasStale && roomy !== null ? roomy : planLine(last, at, columns)
    if (plan.items.length === 0) {
      return <Text dimColor>Plan usage: waiting for the first reading…</Text>
    }

    return (
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={ITEM_GAP} overflow="hidden">
        {plan.items.map(item => {
          const bar = textBar(item.meter)

          return (
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              <Text bold>{item.label}</Text>
              {plan.hasMeters &&
                (Svg !== undefined ? (
                  <Svg source={svgBar(item.meter)} alt={`${item.label}: ${item.figure} used`} width={72} height={6} />
                ) : (
                  <Box flexDirection="row">
                    <Text color={COLOR[item.severity]}>{bar.filled}</Text>
                    <Text dimColor>{bar.empty}</Text>
                  </Box>
                ))}
              <Text bold color={item.isLapsed ? undefined : COLOR[item.severity]} dimColor={item.isLapsed}>
                {item.figure}
              </Text>
              {item.reset !== '' && (
                <Text dimColor wrap="truncate-end">
                  {item.reset}
                </Text>
              )}
            </Box>
          )
        })}
        {hasStale && <Text dimColor>{stale}</Text>}
      </Box>
    )
  })
}
