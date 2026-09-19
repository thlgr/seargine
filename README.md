# seargine

Gives a language model a browser. Ask for a search or a page, get back clean,
short Markdown — no menus, no ads, no ANSI codes, no chatter.

A real Chrome or Brave stays warm in a background daemon, so the first call
takes a few seconds and every one after that is quick. Pages are cleaned up by
[Defuddle](https://github.com/kepano/defuddle). On Linux, `gamescope` can keep
the browser window off your screen.

## Install

You need **Node 20+** and a Chromium browser you already have — Chrome,
Chromium or Brave. seargine points at it; it never downloads its own.

```bash
npm install
npm link
```

That puts `seargine` on your PATH. Check it:

```bash
seargine search "hello world" --limit 3
```

Two things worth knowing:

- With nvm, `npm link` installs into the Node version you have active, so
  `seargine` disappears if you switch versions. Re-run `npm link` there, or
  symlink it into `~/.local/bin`.
- On Linux, install [`gamescope`](https://github.com/ValveSoftware/gamescope)
  if you don't want to see the browser window. Without it, the window shows up
  — the browser is always headful, on purpose.

Don't want it on your PATH? `node bin/seargine.js ...` works the same.

### Give it to your agent

A ready-made skill lives in [`skill/SKILL.md`](skill/SKILL.md). Drop it where
your agent looks for skills:

```bash
mkdir -p ~/.agents/skills/seargine && cp skill/SKILL.md ~/.agents/skills/seargine/
# Claude Code reads ~/.claude/skills instead:
mkdir -p ~/.claude/skills/seargine && cp skill/SKILL.md ~/.claude/skills/seargine/
```

It covers `search` and `fetch` and nothing else — enough for a model to look
things up, short enough that it doesn't drown in options.

## Using it

### Search

```bash
seargine search "node.js esm modules"
seargine search "rust async" --limit 5 --page 2
seargine search "postgres index" --fetch --fetch-limit 3
```

```text
Results for "node.js esm modules" (3 results)

## [Modules: ECMAScript modules | Node.js Documentation](https://nodejs.org/api/esm.html)

Node.js has two module systems: CommonJS and ECMAScript modules.
```

Google, falling back to DuckDuckGo when Google refuses. `--fetch` appends the
Markdown of the top results, so one command can answer a question end to end.

### Fetch

```bash
seargine fetch https://example.com
seargine fetch https://a.com https://b.com --max-chars 2000
```

```markdown
---
title: Example Domain
url: https://example.com/
words: 17
---

# Example Domain

Body in clean Markdown, without menus, sidebars, ads or comments...
```

`--raw` gives you the cleaned HTML instead, `--links` only the links,
`--no-frontmatter` drops the header, `--max-chars` truncates long pages.

### The rest

```bash
seargine links <url>   # just the links
seargine status        # daemon, browser, tab pool, queue
seargine stop          # shut it all down
seargine restart
```

`--json` on any command gives you structured output instead of Markdown.
`--respect-robots` skips URLs robots.txt disallows. Also global: `--timeout`,
`--quiet`, `--config`.

## When it fails

stdout only ever carries what you asked for; logs go to stderr. Errors are one
line and one non-zero exit code:

```text
ERROR: CLOUDFLARE_BLOCKED: challenge did not clear
```

The codes: `TIMEOUT`, `NAV_FAILED`, `CLOUDFLARE_BLOCKED`, `CAPTCHA_UNSUPPORTED`,
`NO_RESULTS`, `BAD_URL`, `DAEMON_ERROR`, `CHROME_NOT_FOUND`, `GAMESCOPE_MISSING`,
`LAUNCH_FAILED`, `ROBOTS_DISALLOWED`.

Cloudflare interstitials are detected, waited out briefly, and otherwise
reported. Image captchas return `CAPTCHA_UNSUPPORTED`. There is no solver —
bypassing those is deliberately out of scope.

## Configuration

Optional. Everything has a default, and flags win over the file.

```bash
$EDITOR ~/.config/seargine/config.json
```

The ones you might actually touch:

| | |
| --- | --- |
| `chromePath` | Your browser binary, if auto-detection picks the wrong one. |
| `searchEngine` | `"google"` (default) or `"duckduckgo"`. |
| `gamescope` | `"auto"`, `"on"` or `"off"`. |
| `poolSize` | Persistent tabs, which is also the concurrency. Default 3. |
| `perDomainRateMs` | Minimum gap between hits on the same host. Default 1500. |
| `idleShutdownMs` | How long the daemon lingers unused. Default 10 min. |

There's also `seedProfile`, on by default: at startup the daemon copies cookies
and preferences from your real browser profile into its own, so it inherits
your trusted session **without locking your profile** — your browser can stay
open. A cold, cookie-less profile gets flagged by a lot of sites.

Timeouts, viewport, user agent and window mode are in there too; the defaults
are chosen to look like an ordinary browser, so change them only if you have a
reason.

## How it works

Two processes. The CLI parses your arguments, talks to the daemon over a Unix
socket, prints, exits — spawning the daemon first if it isn't running. The
daemon owns the browser, a pool of persistent tabs and a job queue.

Jobs never open or close tabs: a tab is handed out, reset to `about:blank`, and
returned to the pool. The queue handles LRU assignment, per-domain rate limits,
timeouts, and deduplication — ask for the same URL twice at once and the second
request joins the first.

To stay unremarkable, the launcher starts your system browser with nothing but
a debugging port and a profile directory, then connects over CDP. No Puppeteer
flag set, no fake user agent — those are fingerprints themselves. `gamescope`
only hides the window; the compositor and fingerprint stay real.

```
bin/     seargine.js (CLI), seargined.js (daemon)
src/     cli, daemon, ipc, config, fetch, search, format, robots
src/browser/  launcher, pool, queue, cloudflare
skill/   SKILL.md for agents
```

## Credits

The Google `/goto?url=` decoder in `src/google-goto.js` is adapted from
[Google-Goto-URL-Extractor](https://github.com/Xyborg/Google-Goto-URL-Extractor)
by Martin Aberastegue (MIT).

## Responsible use

Scraping Google may violate its Terms of Service. This is meant for personal
use on your own sessions. Per-domain rate limiting is always on, and
`--respect-robots` honours robots.txt when you ask it to. Your risk.
