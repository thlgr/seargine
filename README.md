# seargine

seargine lets an AI model search the web and read web pages. You give it a
search or a URL and it prints back short, clean Markdown text. Menus, ads and
other clutter are removed.

It uses the Chrome or Brave you already have installed. The browser keeps
running in the background after the first command, so the first one takes a
few seconds and the rest are fast. The page cleanup is done by
[Defuddle](https://github.com/kepano/defuddle).

## Install

You need Node 20 or newer and Chrome or Chromium (brave etc). seargine uses
your browser. It doesn't download its own.

```bash
npm install
npm link
```

Now you can run `seargine` from any folder. Try it:

```bash
seargine search "hello world" --limit 3
```

If you use nvm, `npm link` only installs it for the Node version you're on
right now. After switching versions, run `npm link` again, or symlink
`seargine` into `~/.local/bin`.

The browser window will show up on your screen. On Linux you can hide it by
installing [gamescope](https://github.com/ValveSoftware/gamescope). seargine
uses it automatically when it's installed.

You can also skip `npm link` and run `node bin/seargine.js` instead.

### Using it with an AI agent

[`skill/SKILL.md`](skill/SKILL.md) tells an agent how to use seargine. Copy it
to the folder where your agent looks for skills:

```bash
mkdir -p ~/.agents/skills/seargine && cp skill/SKILL.md ~/.agents/skills/seargine/
# Claude Code uses ~/.claude/skills instead:
mkdir -p ~/.claude/skills/seargine && cp skill/SKILL.md ~/.claude/skills/seargine/
```

It only covers `search` and `fetch`. That's all the agent needs, and a short
skill is easier for it to follow.

## Usage

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

It searches Google. If Google blocks the search, it tries DuckDuckGo.

`--fetch` also opens the top results and adds their text under the list, so
you can get an answer with a single command.

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

- `--max-chars 2000` cuts the text off after 2000 characters
- `--no-frontmatter` removes the title/url block at the top
- `--links` prints only the links on the page
- `--raw` prints the cleaned HTML instead of Markdown

### Other commands

```bash
seargine links <url>   # only the links on a page
seargine status        # shows if the browser is running
seargine stop          # closes the browser
seargine restart
```

These flags work with any command:

- `--json` prints JSON instead of Markdown
- `--timeout <ms>` how long to wait before giving up
- `--quiet` prints fewer messages
- `--config <path>` uses a different config file

`search` and `fetch` also take `--respect-robots`, which skips pages the site's
robots.txt asks crawlers not to visit.

## Errors

Only the result goes to stdout. Logs and errors go to stderr, so they never
get mixed into the result. When something fails you get one line and a
non-zero exit code:

```text
ERROR: CLOUDFLARE_BLOCKED: challenge did not clear
```

Possible codes: `TIMEOUT`, `NAV_FAILED`, `CLOUDFLARE_BLOCKED`,
`CAPTCHA_UNSUPPORTED`, `NO_RESULTS`, `BAD_URL`, `DAEMON_ERROR`,
`CHROME_NOT_FOUND`, `GAMESCOPE_MISSING`, `LAUNCH_FAILED`, `ROBOTS_DISALLOWED`.

If a site shows a Cloudflare "checking your browser" page, seargine waits a few
seconds for it to go away. If it doesn't, you get `CLOUDFLARE_BLOCKED`. Image
captchas give `CAPTCHA_UNSUPPORTED`. seargine doesn't solve captchas and isn't
going to.

## Configuration

You don't need a config file. If you want one, create
`~/.config/seargine/config.json`:

```json
{
  "searchEngine": "duckduckgo",
  "poolSize": 2
}
```

Command-line flags override the file. The settings you're most likely to
change:

| Setting | What it does |
| --- | --- |
| `chromePath` | Path to your browser, if seargine picks the wrong one. |
| `searchEngine` | `"google"` (default) or `"duckduckgo"`. |
| `gamescope` | `"auto"` (default), `"on"` or `"off"`. |
| `poolSize` | How many tabs stay open, which is also how many pages load at once. Default 3. |
| `perDomainRateMs` | Minimum wait between two requests to the same site. Default 1500 ms. |
| `idleShutdownMs` | How long the browser stays open with nothing to do. Default 10 minutes. |

`seedProfile` is on by default. When seargine starts, it copies the cookies
and settings from your normal browser into its own separate profile. Sites are
less likely to block a browser that has cookies. It only copies them, so your
normal browser can stay open.

There are more settings (timeouts, window size, user agent, window mode). The
defaults are set so it looks like a normal browser, so only change them if you
have a reason to.

## How it works

There are two programs:

- `seargine` is the command you type. It sends your request to the background
  program, prints the answer and exits. If the background program isn't
  running, it starts it first.
- `seargined` is the background program. It runs the browser, keeps a few tabs
  open and puts requests in a queue until a tab is free.

Some details:

- Tabs are reused. A request never opens or closes a tab.
- It waits at least 1.5 seconds between requests to the same site.
- If you ask for the same URL twice at the same time, it only loads it once.
- The browser is started with almost no extra options and keeps its real user
  agent. Unusual options make it easier for sites to tell it's automated.
- gamescope only hides the window. The browser still runs the same way.

```
bin/          seargine.js (the command), seargined.js (the background program)
src/          cli, daemon, ipc, config, fetch, search, format, robots
src/browser/  launcher, pool, queue, cloudflare
skill/        SKILL.md for agents
```

## Credits

The code that decodes Google `/goto?url=` links in `src/google-goto.js` is
adapted from
[Google-Goto-URL-Extractor](https://github.com/Xyborg/Google-Goto-URL-Extractor)
by Martin Aberastegue (MIT).

## Use at your own risk

Scraping Google may go against its Terms of Service. seargine is meant for
personal use. It always limits how often it hits the same site, and
`--respect-robots` makes it follow robots.txt. How you use it is up to you.
