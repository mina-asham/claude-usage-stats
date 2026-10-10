# claude-usage-stats

A Claude Code mod that keeps your Claude plan usage on one line above the prompt, in the desktop app's Code tab and in the terminal:

```
Session ███░░░░░░░ 23%  resets 7:10 PM (2h 54m)   Week ████░░░░░░ 40%  resets Sun 5:00 PM (1d)
```

## What it shows

- **Session**: the rolling 5-hour window.
- **Week**: the 7-day window.
- **Week · <model>**: a per-model weekly limit, shown once it has some usage.

Each window has a meter (an SVG bar on the desktop, block characters in the terminal), the percentage used (rounded down, as `/usage` shows it), and when it resets, as a clock time and a countdown. Colours turn amber from 70% and red from 90%.

The band always stays on one line. When the window is narrow it gives things up in this order:

1. The per-model weekly limits.
2. The meters.
3. The clock times.
4. The words around the countdowns.
5. The countdowns themselves.

The two percentages are the last to go. A window that has reset since it was last read shows `—`. A reading that has gone stale says `updated 12m ago`.

## Where the numbers come from

- **Each reply.** Claude Code reads your rate-limit windows from every model response. The band takes each new reading in as soon as it arrives.
- **The account usage endpoint.** This is `GET https://api.anthropic.com/api/oauth/usage`, the same endpoint Claude Code's `/usage` reads. The band asks it once a minute, using the session's own login. This picks up usage from your other sessions and from claude.ai.
  - **Throttling:** on a 429, a 403 or a rate-limit body, the band waits as long as `Retry-After` says, or 5 minutes, as Claude Code does.
  - **Errors:** a server error waits 2 minutes. A 404 stops it asking for the rest of the session.
  - **Undocumented:** this endpoint is not a public API and may change.
- **Redraws.** The band redraws every 3 seconds, so countdowns stay current.

You need to be signed in with a Claude subscription (Pro, Max, Team or Enterprise). An API key or a third-party provider has no plan windows.

## Commands

| Command | What it does |
| --- | --- |
| `/usage-stats` or `/usage-stats refresh` | Prints the figures. Asks the endpoint unless it is throttling you. |
| `/usage-stats hide` | Hides the band and stops asking the endpoint. The setting is remembered across sessions. |
| `/usage-stats show` | Brings the band back. |

## Install

Run this in a Claude Code session in a terminal:

```
/plugin install usage-stats --marketplace mina-asham/claude-usage-stats
```

1. Answer `y` to add the marketplace.
2. Choose a scope. Use the user scope so it loads in every session, including the desktop app's Code tab. The command isn't available inside the desktop app itself, but a mod installed from a terminal at user scope loads there too.

This repository is private, so installing needs your GitHub access through git.

## Developing

The mod is a Claude Code plugin of function hooks. That API is early access, and this mod was built against Claude Code 2.1.293.

```
claude --plugin-dir .          # run it from this folder for one session
claude plugin validate .       # check the manifest and hooks the way the engine reads them
claude plugin test .           # run hooks/usage-stats.test.tsx
```

| Path | Contents |
| --- | --- |
| `hooks/register.tsx` | The hooks: start, measure, the command, and the band. |
| `hooks/format.ts` | Parsing, merging readings, and the one-line layout. |
| `types/index.d.ts` | The mod's `$.state` contract. |

When Claude Code loads the mod it writes `.claude-plugin/types/` for your editor. That folder is generated and not committed.
