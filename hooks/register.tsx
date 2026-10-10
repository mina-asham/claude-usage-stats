import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot, UsageWindow } from '../types'
import {
  ITEM_GAP,
  formatAge,
  formatCountdown,
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

/** How often the band redraws and takes in what changed. */
const REFRESH_MS = 3_000
/**
 * How often the endpoint is asked: Claude Code treats a reading as fresh for a
 * minute, and the endpoint throttles callers that ask much more often. Each
 * reply's own reading reaches the band at once in between (session.measure).
 */
const POLL_MS = 60_000
/** After a 5xx, a network failure or an unreadable answer. */
const RETRY_MS = 2 * 60_000
/** After a throttle (429, 403, or a rate-limit body) that names no Retry-After, as Claude Code waits. */
const THROTTLED_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000
const STALE_MS = 3 * 60_000

const snapshot = atom({ plugin: 'usage-stats', key: 'snapshot' } as const, null)
const now = atom({ plugin: 'usage-stats', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-stats', key: 'isHidden' } as const, false)
const error = atom({ plugin: 'usage-stats', key: 'error' } as const, null)

const COLOR = { ok: 'success', warn: 'warning', high: 'error' } as const

type Fetched =
  | { windows: UsageWindow[] }
  | { error: string; retryAfterMs: number; isThrottled: boolean }

/** A request is out: the next tick skips rather than piling one on. A reload drops it with the old module. */
let isInFlight = false
/** When the endpoint may next be asked. */
let nextFetchAt = 0
/** The endpoint is throttling us until `nextFetchAt`: even the command waits. */
let isThrottled = false

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

function retryAfterOf(header: string | undefined, at: number): number {
  if (header === undefined) return THROTTLED_MS
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - at

  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_BACKOFF_MS, Math.max(REFRESH_MS, ms)) : THROTTLED_MS
}

async function fetchUsage($: EngineInterface): Promise<Fetched> {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') {
    return { error: 'plan usage needs a Claude subscription login', retryAfterMs: THROTTLED_MS, isThrottled: false }
  }

  const response = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
  })
  const answeredAt = await $.clock.now()
  const { status } = response
  if (status === 429 || status === 403) {
    const retryAfterMs = retryAfterOf(response.headers['retry-after'], answeredAt)

    return { error: 'the usage endpoint is rate limiting', retryAfterMs, isThrottled: true }
  }
  if (status === 404) {
    return { error: 'the usage endpoint is not available', retryAfterMs: Number.POSITIVE_INFINITY, isThrottled: false }
  }
  if (status === 401) {
    return { error: 'the usage endpoint refused the login', retryAfterMs: THROTTLED_MS, isThrottled: false }
  }
  if (!response.ok) {
    return { error: `the usage endpoint answered ${status}`, retryAfterMs: RETRY_MS, isThrottled: false }
  }

  let body: unknown
  try {
    body = JSON.parse(response.text)
  } catch {
    return { error: 'the usage endpoint answered with something unreadable', retryAfterMs: RETRY_MS, isThrottled: false }
  }
  if (isRateLimitEnvelope(body)) {
    const retryAfterMs = retryAfterOf(response.headers['retry-after'], answeredAt)

    return { error: 'the usage endpoint is rate limiting', retryAfterMs, isThrottled: true }
  }

  const windows = parseUsage(body)

  return windows.length > 0
    ? { windows }
    : { error: 'the usage endpoint listed no windows', retryAfterMs: RETRY_MS, isThrottled: false }
}

/** Asks the endpoint unless one request is out or the backoff says wait; `isAsked` (the command) skips an ordinary wait, never a throttle. */
async function refresh($: EngineInterface, isAsked: boolean): Promise<void> {
  if (isInFlight) return
  const sentAt = await $.clock.now()
  if (sentAt < nextFetchAt && (!isAsked || isThrottled)) return

  isInFlight = true
  try {
    const fetched = await fetchUsage($)
    const doneAt = await $.clock.now()
    if ('error' in fetched) {
      nextFetchAt = doneAt + fetched.retryAfterMs
      isThrottled = fetched.isThrottled
      await setError($, fetched.error)

      return
    }

    nextFetchAt = doneAt + POLL_MS
    isThrottled = false
    // Stamped when it was sent: a reply's reading that landed meanwhile is newer and keeps its place.
    await apply($, fetched.windows, 'api', sentAt)
    await setError($, null)
  } catch (thrown) {
    nextFetchAt = (await $.clock.now()) + RETRY_MS
    isThrottled = false
    const reason = thrown instanceof Error ? thrown.message : String(thrown)
    await setError($, `could not reach the usage endpoint: ${reason.slice(0, 120)}`)
  } finally {
    isInFlight = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!(await read($, isHidden))) await refresh($, false)
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
      argumentHint: '[refresh|show|hide]',
    })

    const storedHidden = await $.store.get('isHidden')
    if (typeof storedHidden === 'boolean') await update($, isHidden, () => storedHidden)

    // A reload keeps the session's snapshot; only a fresh start takes the session's figures or the stored ones.
    if ((await read($, snapshot)) === null) {
      const live = await $.session.usage()
      const readAt = await $.clock.now()
      const stored = await $.store.get('snapshot')
      if (isSnapshot(stored)) await update($, snapshot, () => stored)
      if (live.rateLimits.length > 0) await apply($, live.rateLimits, 'session', readAt)
    }

    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    $.clock.every(REFRESH_MS, () => void tick($))
    // Off the start path: the first prompt never waits on the network.
    $.clock.after(1, () => void tick($))

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

    await refresh($, true)
    const at = await $.clock.now()
    const lines = summaryLines(await read($, snapshot), at)
    const problem = await read($, error)
    const wait = isThrottled && nextFetchAt > at ? `; asking again in ${formatCountdown(nextFetchAt - at)}` : ''
    const note = problem ? `(${problem}${wait})` : ''
    if (lines.length === 0) return { text: `No plan usage reading yet${note ? ` ${note}` : ''}.` }

    return { text: [...lines, ...(note ? [note] : [])].join('\n') }
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
    const stale = age >= STALE_MS ? `updated ${formatAge(age)}` : ''
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
