/** One plan-usage window: `five_hour` (the session), `seven_day` (the week), or a per-model week. */
export type UsageWindow = {
  kind: string
  /** 0 to 100, past 100 on an exceeded limit. */
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
  /** The server's name for a scoped window (`Opus`), where it gave one. */
  label?: string
  /** When this window's figure was read, in milliseconds since the epoch; a newer reading of the window wins. */
  readAt?: number
}

/** The latest reading of every window, and where and when it came from. */
export type UsageSnapshot = {
  windows: UsageWindow[]
  /** When the newest reading in it was taken, in milliseconds since the epoch. */
  observedAt: number
  /** `session`: a model response's rate-limit headers; `api`: the account's usage endpoint. */
  source: 'session' | 'api'
}

declare module 'claude-code' {
  interface PluginState {
    'usage-stats': {
      snapshot: UsageSnapshot | null
      /** The clock as of the last tick, so countdowns redraw. */
      now: number
      isHidden: boolean
      /** Why the last refresh from the usage endpoint failed, if it did. */
      error: string | null
    }
  }
}
