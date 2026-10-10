import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

import {
  formatCountdown,
  formatPercent,
  hasLapsed,
  labelOf,
  mergeSnapshot,
  parseUsage,
  planLine,
  summaryLines,
  textBar,
} from './format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 9, 10, 14, 0)
const SURFACES = ['terminal', 'desktop'] as const
const URL = 'https://api.anthropic.com/api/oauth/usage'
const SHARED = '/home/test/.claude/usage-stats/endpoint.json'

const iso = (ms: number) => new Date(ms).toISOString()

const LIVE: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 38, resetsAt: iso(NOW + 112 * MINUTE) },
  { kind: 'seven_day', percentUsed: 21.5, resetsAt: iso(NOW + 76 * HOUR) },
]

const API_BODY = {
  five_hour: { utilization: 12, resets_at: iso(NOW + 3 * HOUR) },
  seven_day: { utilization: 64, resets_at: iso(NOW + 100 * HOUR) },
  seven_day_oauth_apps: null,
  seven_day_opus: { utilization: 0, resets_at: null },
  seven_day_sonnet: { utilization: 7, resets_at: iso(NOW + 100 * HOUR) },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
}

type World = {
  live?: SessionRateLimit[]
  api?: unknown
  status?: number
  headers?: Record<string, string>
  isLoggedIn?: boolean
  /** How long each request takes, on the mocked clock. */
  delayMs?: number
  /** What another session left in the shared file. */
  shared?: unknown
}

function world(on: On, options: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  const fetched: number[] = []
  let api: unknown = options.api ?? API_BODY
  const files = new Map<string, string>()
  if (options.shared !== undefined) files.set(SHARED, JSON.stringify(options.shared))

  on('fs.read', ($, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: options.live ?? [] },
  }))
  on('session.authorize', () => ({
    value: options.isLoggedIn === false ? null : { handle: 'handle-1', kind: 'bearer' as const },
  }))
  on('http.fetch', async ($, e) => {
    expect(e.url).toBe(URL)
    fetched.push(clock.now() - NOW)
    if (options.delayMs !== undefined) await clock.sleep(options.delayMs)
    const status = options.status ?? 200

    return { value: { status, ok: status < 300, headers: options.headers ?? {}, text: JSON.stringify(api) } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return {
    clock,
    fetched,
    setApi: (next: unknown) => (api = next),
    shared: () => JSON.parse(files.get(SHARED) ?? 'null') as Record<string, unknown> | null,
  }
}

const START = { cwd: '/tmp', surface: 'desktop' as const, isInteractive: true }

function band(surface: (typeof SURFACES)[number], bodyColumns = 160) {
  return {
    plugin: 'usage-stats',
    surface,
    component: 'AbovePrompt' as const,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }
}

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

describe('format', () => {
  test('parses the usage endpoint, keeping only windows', async () => {
    const windows = parseUsage(API_BODY)
    expect(windows.map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'])
    expect(windows[0]).toEqual({ kind: 'five_hour', percentUsed: 12, resetsAt: API_BODY.five_hour.resets_at })
    expect(windows[2]).toEqual({ kind: 'seven_day_opus', percentUsed: 0 })
    expect(parseUsage(null)).toEqual([])
    expect(parseUsage({ five_hour: { utilization: 'x' } })).toEqual([])
  })

  test('limits[] rows name the meters, the older fields filling in a missing session or week', async () => {
    const body = {
      ...API_BODY,
      limits: [
        { kind: 'session', group: 'session', percent: 44, resets_at: iso(NOW + HOUR), severity: 'normal', is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 71, resets_at: iso(NOW + 50 * HOUR), severity: 'warning' },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 9,
          resets_at: null,
          scope: { model: { display_name: 'Sonnet 4.5' } },
          severity: 'normal',
        },
        { kind: 'spend', group: 'monthly', percent: 54, resets_at: iso(NOW + 400 * HOUR) },
      ],
    }
    expect(parseUsage(body)).toEqual([
      { kind: 'five_hour', percentUsed: 44, resetsAt: iso(NOW + HOUR) },
      { kind: 'seven_day', percentUsed: 71, resetsAt: iso(NOW + 50 * HOUR) },
      { kind: 'seven_day_sonnet_4_5', percentUsed: 9, label: 'Sonnet 4.5' },
    ])
    expect(labelOf('seven_day_sonnet_4_5', 'Sonnet 4.5')).toBe('Week · Sonnet 4.5')
    expect(parseUsage({ ...API_BODY, limits: [] })[0]?.percentUsed).toBe(12)

    const scopedOnly = parseUsage({ ...API_BODY, limits: [body.limits[2]] })
    expect(scopedOnly.map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet_4_5'])
  })

  test('counts down in minutes, hours and days', async () => {
    expect(formatCountdown(0)).toBe('now')
    expect(formatCountdown(30_000)).toBe('1m')
    expect(formatCountdown(45 * MINUTE)).toBe('45m')
    expect(formatCountdown(112 * MINUTE)).toBe('1h 52m')
    expect(formatCountdown(2 * HOUR)).toBe('2h')
    expect(formatCountdown(76 * HOUR)).toBe('3d 4h')
    expect(formatCountdown(48 * HOUR)).toBe('2d')
  })

  test('labels, percentages rounded down as /usage shows them, and bars', async () => {
    expect(labelOf('five_hour')).toBe('Session')
    expect(labelOf('seven_day')).toBe('Week')
    expect(labelOf('seven_day_opus')).toBe('Week · Opus')
    expect(formatPercent(0.4)).toBe('<1%')
    expect(formatPercent(21.5)).toBe('21%')
    expect(formatPercent(99.9)).toBe('99%')
    expect(parseUsage({ five_hour: { utilization: 99.96, resets_at: null } })[0]?.percentUsed).toBe(99.9)
    expect(textBar(0)).toEqual({ filled: '', empty: '░'.repeat(10) })
    expect(textBar(3).filled).toBe('█')
    expect(textBar(140).filled).toBe('█'.repeat(10))
  })

  test('a newer reading wins per window; a reply reading keeps the per-model weeks beside it', async () => {
    const fromApi = mergeSnapshot(null, parseUsage(API_BODY), 'api', NOW)
    const merged = mergeSnapshot(fromApi, LIVE, 'session', NOW + MINUTE)
    expect(merged.source).toBe('session')
    expect(merged.windows.find(w => w.kind === 'five_hour')?.percentUsed).toBe(38)
    expect(merged.windows.find(w => w.kind === 'seven_day_sonnet')).toMatchObject({ percentUsed: 7, readAt: NOW })

    const withoutReset = mergeSnapshot(merged, [{ kind: 'five_hour', percentUsed: 40 }], 'session', NOW + 2 * MINUTE)
    expect(withoutReset.windows[0]?.resetsAt).toBe(LIVE[0]?.resetsAt)

    // An endpoint answer sent before that reply's reading landed does not undo it.
    const late = mergeSnapshot(merged, parseUsage(API_BODY), 'api', NOW + 30_000)
    expect(late.windows.find(w => w.kind === 'five_hour')?.percentUsed).toBe(38)
    expect(late.observedAt).toBe(NOW + MINUTE)
  })

  test('an endpoint answer is the whole picture: a window it stops listing goes', async () => {
    const before = mergeSnapshot(null, parseUsage(API_BODY), 'api', NOW)
    const after = mergeSnapshot(before, parseUsage({ ...API_BODY, seven_day_sonnet: null }), 'api', NOW + MINUTE)
    expect(after.windows.map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
  })

  test('a window lapses once its reset passes, judged by when that window was read', async () => {
    const window = LIVE[0]!
    expect(hasLapsed(window, NOW, NOW + HOUR)).toBe(false)
    expect(hasLapsed(window, NOW, NOW + 2 * HOUR)).toBe(true)
    expect(hasLapsed(window, NOW + 2 * HOUR, NOW + 2 * HOUR)).toBe(false)
    expect(summaryLines(null, NOW)).toEqual([])

    // A reply's figure for a window that had already reset when it was taken in predates that reset.
    const old = mergeSnapshot(null, [{ kind: 'five_hour', percentUsed: 97, resetsAt: iso(NOW - 10 * MINUTE) }], 'session', NOW)
    expect(hasLapsed(old.windows[0]!, old.observedAt, NOW)).toBe(true)
  })

  test('one line gives up the per-model weeks, the meters, the clock times, then the words', async () => {
    const reading = mergeSnapshot(null, parseUsage(API_BODY), 'api', NOW)
    const plan = (columns: number) => planLine(reading, NOW, columns)

    expect(plan(200).items.map(i => i.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet'])
    expect(plan(200).hasMeters).toBe(true)
    expect(plan(110).items.map(i => i.kind)).toEqual(['five_hour', 'seven_day'])
    expect(plan(110).hasMeters).toBe(true)
    expect(plan(75).hasMeters).toBe(false)
    expect(plan(75).items[0]?.reset).toMatch(/^resets .+ \(3h\)$/)
    expect(plan(57).items.map(i => i.reset)).toEqual(['resets in 3h', 'resets in 4d 4h'])
    expect(plan(40).items.map(i => i.reset)).toEqual(['3h', '4d 4h'])
    expect(plan(25).items.map(i => `${i.label} ${i.figure} ${i.reset}`)).toEqual(['Session 12% ', 'Week 64% '])

    for (const columns of [200, 110, 75, 57, 40, 25]) expect(plan(columns).width).toBeLessThanOrEqual(columns)
  })

  test('the form holds at a fixed width as the countdowns tick down', async () => {
    const reading = mergeSnapshot(
      null,
      [
        { kind: 'five_hour', percentUsed: 41, resetsAt: iso(NOW + 5 * HOUR) },
        { kind: 'seven_day', percentUsed: 27, resetsAt: iso(NOW + 100 * HOUR) },
      ],
      'api',
      NOW,
    )
    const formOf = (columns: number, at: number) => {
      const plan = planLine(reading, at, columns)

      return `${plan.hasMeters}|${plan.items.map(i => i.reset.replace(/[0-9]+[dhm]( [0-9]+[hm])?/g, 'N')).join('/')}`
    }

    const flipping: number[] = []
    for (let columns = 20; columns <= 140; columns++) {
      const forms = new Set<string>()
      for (let minute = 1; minute < 5 * 60; minute++) forms.add(formOf(columns, NOW + minute * MINUTE))
      if (forms.size > 1) flipping.push(columns)
    }
    expect(flipping).toEqual([])
  })
})

describe('band', () => {
  test('shows the session and the week with reset times, on every surface', async ($, on) => {
    const { fetched } = world(on, { live: LIVE })
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'row', flexWrap: 'nowrap' } })
      expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^resets .+ \(1h 52m\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Week' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^resets .+ \(3d 4h\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      // The desktop draws an SVG meter, the terminal block characters.
      expect((await ui.find({ type: 'Svg' })) === undefined).toBe(surface === 'terminal')
      expect((await ui.find({ type: 'Text', text: /^█+$/ })) === undefined).toBe(surface === 'desktop')
      await ui.unmount()
    }

    expect(fetched).toEqual([])
  })

  test('stays on one line however narrow, the figures last to go', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: LIVE, changed: ['rateLimits'] })

    for (const columns of [160, 70, 60, 40, 25]) {
      const ui = await $.ui.mount(band('desktop', columns))
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'row', flexWrap: 'nowrap' } })
      expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
      await ui.unmount()
    }

    const at60 = await $.ui.mount(band('desktop', 60))
    expect(await at60.find({ type: 'Svg' })).toBeUndefined()
    expect(await at60.find({ type: 'Text', text: 'resets in 1h 52m' })).toBeDefined()
    await at60.unmount()
    const at40 = await $.ui.mount(band('desktop', 40))
    expect(await at40.find({ type: 'Text', text: '1h 52m' })).toBeDefined()
  })

  test('fills in from the usage endpoint before the first reply', async ($, on) => {
    const { clock, fetched } = world(on)
    await $.session.start(START)

    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ type: 'Text', text: /waiting for the first reading/ })).toBeDefined()

    await clock.advance(1)
    expect(fetched).toEqual([1])
    expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '64%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week · Sonnet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week · Opus' })).toBeUndefined()
  })

  test('redraws every 3 seconds and asks the endpoint every three minutes', async ($, on) => {
    const { clock, fetched, setApi, shared } = world(on, { live: LIVE })
    await $.session.start(START)
    const ui = await $.ui.mount(band('desktop'))

    await clock.advance(1)
    expect(fetched).toEqual([1])
    expect(shared()).toMatchObject({ nextAt: NOW + 1 + 3 * MINUTE, wait: 'answered', answer: { at: NOW + 1 } })
    expect(await ui.find({ type: 'Text', text: /\(3h\)$/ })).toBeDefined()

    setApi({ ...API_BODY, five_hour: { utilization: 13, resets_at: API_BODY.five_hour.resets_at } })
    await clock.advance(60_000)
    expect(fetched).toEqual([1])
    expect(await ui.find({ type: 'Text', text: /\(2h 59m\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()

    await clock.advance(123_000)
    expect(fetched).toEqual([1, 183_000])
    expect(await ui.find({ type: 'Text', text: '13%' })).toBeDefined()

    await clock.advance(10 * MINUTE)
    expect(fetched).toEqual([1, 183_000, 363_000, 543_000, 723_000])
  })

  test("takes in another session's recent answer instead of asking", async ($, on) => {
    const other = parseUsage({ ...API_BODY, five_hour: { utilization: 55, resets_at: API_BODY.five_hour.resets_at } })
    const { clock, fetched } = world(on, {
      shared: { nextAt: NOW + 100_000, wait: 'answered', answer: { at: NOW - 20_000, windows: other } },
    })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await $.ui.mount(band('desktop', 200))

    expect(fetched).toEqual([])
    expect(await ui.find({ type: 'Text', text: '55%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week · Sonnet' })).toBeDefined()

    await clock.advance(99_000)
    expect(fetched).toEqual([])
    await clock.advance(3_000)
    expect(fetched).toEqual([102_000])
  })

  test('a reading carried over from an earlier process never outranks a timestamped one', async ($, on) => {
    const older = parseUsage({ ...API_BODY, five_hour: { utilization: 35, resets_at: API_BODY.five_hour.resets_at } })
    const { clock, fetched } = world(on, {
      live: [{ kind: 'five_hour', percentUsed: 17, resetsAt: API_BODY.five_hour.resets_at }],
      shared: { nextAt: NOW + 100_000, wait: 'answered', answer: { at: NOW - 100_000, windows: older } },
    })
    await $.session.start(START)
    const before = await $.ui.mount(band('desktop'))
    expect(await before.find({ type: 'Text', text: '17%' })).toBeDefined()
    expect(await before.find({ type: 'Text', text: 'age unknown' })).toBeDefined()
    await before.unmount()

    await clock.advance(1)
    const ui = await $.ui.mount(band('desktop'))
    expect(fetched).toEqual([])
    expect(await ui.find({ type: 'Text', text: '35%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'age unknown' })).toBeUndefined()
  })

  test("takes over the turn once another session's claim goes stale", async ($, on) => {
    const { clock, fetched } = world(on, {
      live: LIVE,
      shared: { nextAt: NOW + 45_000, wait: 'asking', claimedBy: 'other' },
    })
    await $.session.start(START)
    await clock.advance(1)
    await clock.advance(42_000)
    expect(fetched).toEqual([])
    await clock.advance(3_000)
    expect(fetched).toEqual([45_000])
  })

  test("shares a throttle: no session asks until it is over", async ($, on) => {
    const { clock, fetched } = world(on, {
      live: LIVE,
      shared: { nextAt: NOW + 4 * MINUTE, wait: 'throttled', error: 'the usage endpoint is rate limiting' },
    })
    await $.session.start(START)
    await clock.advance(1)
    const { text } = await $.command.run({ command: 'usage-stats', args: '', ...RUN })
    expect(text).toMatch(/\(the usage endpoint is rate limiting; next read in 4m\)$/)
    await clock.advance(4 * MINUTE)
    expect(fetched).toEqual([4 * MINUTE])
  })

  test('never has two requests out at once', async ($, on) => {
    const { clock, fetched } = world(on, { live: LIVE, delayMs: 5_000 })
    await $.session.start(START)

    await clock.advance(1)
    expect(fetched).toEqual([1])
    await $.command.run({ command: 'usage-stats', args: '', ...RUN })
    expect(fetched).toEqual([1])

    await clock.advance(5_000)
    expect(fetched).toEqual([1])
  })

  test('the command never asks ahead of the shared turn', async ($, on) => {
    const { clock, fetched } = world(on, { live: LIVE })
    await $.session.start(START)
    await clock.advance(1)
    expect(fetched).toEqual([1])

    const first = await $.command.run({ command: 'usage-stats', args: '', ...RUN })
    const second = await $.command.run({ command: 'usage-stats', args: 'refresh', ...RUN })
    expect(fetched).toEqual([1])
    expect(first.text).toMatch(/^Session: 12% used/)
    expect(first.text).toMatch(/\(usage endpoint read just now; next read in 3m\)$/)
    expect(second.text).toBe(first.text)

    const { text } = await $.command.run({ command: 'usage-stats', args: 'debug', ...RUN })
    expect(text).toBe(
      'Shared turn: answered, next read in 3m.\nRequests this session sent (1, oldest first):\njust now  start  200  0ms',
    )
  })

  test('pauses while the band is hidden', async ($, on) => {
    const { clock, fetched } = world(on, { live: LIVE })
    await $.session.start(START)
    await $.command.run({ command: 'usage-stats', args: 'hide', ...RUN })

    await clock.advance(5 * MINUTE)
    expect(fetched).toEqual([])

    await $.command.run({ command: 'usage-stats', args: 'show', ...RUN })
    await clock.advance(3_000)
    expect(fetched).toHaveLength(1)
  })

  test("takes in each reply's new reading at once, never an old one again", async ($, on) => {
    const { clock } = world(on, { live: LIVE })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()

    // A turn ends with only the context moved: its rate limits are the old reading.
    await $.session.measure({ context: { window: 200_000 }, rateLimits: LIVE, changed: ['context', 'cost'] })
    expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()

    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: API_BODY.five_hour.resets_at }],
      changed: ['rateLimits'],
    })
    expect(await ui.find({ type: 'Text', text: '91%' })).toMatchObject({ props: { color: 'error' } })
    expect(await ui.find({ type: 'Text', text: '64%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Week · Sonnet' })).toBeDefined()
  })

  test('a per-model week the endpoint stops listing leaves the band', async ($, on) => {
    const { clock, setApi } = world(on)
    await $.session.start(START)
    await clock.advance(1)
    const ui = await $.ui.mount(band('desktop', 200))
    expect(await ui.find({ type: 'Text', text: 'Week · Sonnet' })).toBeDefined()

    setApi({ ...API_BODY, seven_day_sonnet: null })
    await clock.advance(183_000)
    expect(await ui.find({ type: 'Text', text: 'Week · Sonnet' })).toBeUndefined()
  })

  test('a window shows a dash once it resets with no new reading', async ($, on) => {
    const { clock, fetched } = world(on, { isLoggedIn: false })
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: LIVE, changed: ['rateLimits'] })
    await clock.advance(113 * MINUTE)
    const ui = await $.ui.mount(band('desktop'))

    expect(fetched).toEqual([])
    expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^reset / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^updated .+ ago$/ })).toBeDefined()
  })

  test('says why when there is no subscription login', async ($, on) => {
    const { clock, fetched } = world(on, { isLoggedIn: false })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await $.ui.mount(band('desktop'))

    expect(fetched).toEqual([])
    expect(await ui.find({ type: 'Text', text: /unavailable: plan usage needs a Claude subscription login/ })).toBeDefined()
  })

  test('waits two minutes after a server error, counted from the answer', async ($, on) => {
    const { clock, fetched } = world(on, { status: 500, delayMs: 2_000 })
    await $.session.start(START)
    await clock.advance(1)
    await clock.advance(2_000)
    expect(fetched).toEqual([1])

    await clock.advance(120_000)
    expect(fetched).toEqual([1])
    await clock.advance(3_000)
    expect(fetched).toEqual([1, 123_000])
  })

  test('waits out a 429 as long as Retry-After says, from when it was answered', async ($, on) => {
    const { clock, fetched } = world(on, { live: LIVE, status: 429, headers: { 'retry-after': '20' }, delayMs: 2_000 })
    await $.session.start(START)
    await clock.advance(1)
    await clock.advance(2_000)
    expect(fetched).toEqual([1])

    await clock.advance(19_000)
    expect(fetched).toEqual([1])
    await clock.advance(3_000)
    expect(fetched).toEqual([1, 24_000])
  })

  for (const [name, status, api] of [
    ['a 429 with no Retry-After', 429, API_BODY],
    ['a 403', 403, API_BODY],
    ['a rate-limit body', 200, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }],
  ] as const) {
    test(`waits five minutes after ${name}, and the command waits too`, async ($, on) => {
      const { clock, fetched } = world(on, { status, api })
      await $.session.start(START)
      await clock.advance(1)
      expect(fetched).toEqual([1])
      const ui = await $.ui.mount(band('desktop'))
      expect(await ui.find({ type: 'Text', text: /unavailable: the usage endpoint is rate limiting/ })).toBeDefined()

      const { text } = await $.command.run({ command: 'usage-stats', args: 'refresh', ...RUN })
      expect(text).toMatch(/\(the usage endpoint is rate limiting; next read in 5m\)/)
      expect(fetched).toEqual([1])

      await clock.advance(5 * MINUTE)
      expect(fetched).toEqual([1])
      await clock.advance(3_000)
      expect(fetched).toEqual([1, 303_000])
    })
  }

  test('waits an hour when the endpoint is not there', async ($, on) => {
    const { clock, fetched } = world(on, { live: LIVE, status: 404 })
    await $.session.start(START)
    await clock.advance(1)
    await clock.advance(59 * MINUTE)
    expect(fetched).toEqual([1])
    await clock.advance(MINUTE + 3_000)
    expect(fetched).toHaveLength(2)
  })

  test('waits an hour when the login is refused (a 401, or a 403 with an error body)', async ($, on) => {
    const { clock, fetched } = world(on, {
      live: LIVE,
      status: 403,
      api: { type: 'error', error: { type: 'permission_error', message: 'no profile scope' } },
    })
    await $.session.start(START)
    await clock.advance(1)
    const { text } = await $.command.run({ command: 'usage-stats', args: '', ...RUN })
    expect(text).toMatch(/\(the usage endpoint refused the login; next read in 1h\)$/)
    await clock.advance(59 * MINUTE)
    expect(fetched).toEqual([1])
  })

  test('keeps the age marker in view when a reading is old, before the meters', async ($, on) => {
    const { clock } = world(on, { status: 404 })
    await $.session.start(START)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: LIVE, changed: ['rateLimits'] })
    await clock.advance(10 * MINUTE)

    const ui = await $.ui.mount(band('desktop', 90))
    expect(await ui.find({ type: 'Text', text: 'updated 10m ago' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
  })
})

describe('command', () => {
  test('answers with the figures', async ($, on) => {
    world(on, { live: LIVE })
    await $.session.start(START)

    const { text } = await $.command.run({ command: 'usage-stats', args: '', ...RUN })
    expect(text).toMatch(/^Session: 12% used · resets .+ · in 3h$/m)
    expect(text).toMatch(/^Week: 64% used · resets .+ · in 4d 4h$/m)
  })

  test('hides and shows the band', async ($, on) => {
    world(on, { live: LIVE })
    await $.session.start(START)

    const hidden = await $.command.run({ command: 'usage-stats', args: 'hide', ...RUN })
    expect(hidden.text).toMatch(/hidden/)
    let ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()

    await $.command.run({ command: 'usage-stats', args: 'show', ...RUN })
    ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ type: 'Text', text: '38%' })).toBeDefined()
  })
})
