import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loadConfig, socketPath } from './config.js';
import { sendRequest, isDaemonAlive } from './ipc.js';
import { formatFetchMarkdown, formatLinksMarkdown, formatSearchMarkdown, truncate } from './format.js';
import { isAllowedByRobots } from './robots.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const int = (value) => parseInt(value, 10);

function toError(response) {
  const error = new Error(response?.message || 'unknown daemon error');
  error.code = response?.code || 'DAEMON_ERROR';
  return error;
}

function reportError(error, opts = {}) {
  const code = error.code || 'DAEMON_ERROR';
  if (opts.json) {
    process.stderr.write(`${JSON.stringify({ ok: false, code, message: error.message })}\n`);
  } else {
    process.stderr.write(`ERROR: ${code}: ${error.message}\n`);
  }
}

async function execute(opts, fn) {
  try {
    await fn();
  } catch (error) {
    reportError(error, opts);
    process.exitCode = 1;
  }
}

function addCommonOptions(command) {
  return command
    .option('--timeout <ms>', 'job timeout in milliseconds', int)
    .option('--json', 'output structured JSON instead of Markdown')
    .option('--quiet', 'suppress diagnostics');
}

function spawnDaemon(config) {
  const daemonEntry = fileURLToPath(new URL('../bin/seargined.js', import.meta.url));
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEB_FETCH_CONFIG: config._configPath || '' },
  });
  child.unref();
}

async function waitForDaemon(sock, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonAlive(sock)) return;
    await sleep(200);
  }
  throw Object.assign(new Error('daemon failed to start (check seargine.log)'), { code: 'DAEMON_ERROR' });
}

async function waitForStopped(sock, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDaemonAlive(sock))) return;
    await sleep(150);
  }
}

async function withDaemon(config, fn) {
  const sock = socketPath();
  if (!(await isDaemonAlive(sock))) {
    spawnDaemon(config);
    await waitForDaemon(sock, 25000);
  }
  return fn(sock);
}

function requestTimeout(opts, config) {
  const job = opts.timeout || config.jobTimeoutMs || 30000;
  return job + 20000;
}

async function guardRobots(urls, opts) {
  if (!opts.respectRobots) return;
  for (const url of urls) {
    let allowed = true;
    try {
      allowed = await isAllowedByRobots(url);
    } catch {
      allowed = true;
    }
    if (!allowed) {
      throw Object.assign(new Error(`robots.txt disallows fetching ${url}`), { code: 'ROBOTS_DISALLOWED' });
    }
  }
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderStatus(status) {
  const lines = [
    'daemon: running',
    `pid: ${status.pid}`,
    `uptime: ${formatUptime(status.uptimeMs)}`,
    `socket: ${status.socket}`,
    `config: ${status.configPath}`,
  ];
  if (status.browser) {
    lines.push(`browser: running (pid ${status.browser.pid}, display ${status.browser.display})`);
    lines.push(`chrome: ${status.browser.chrome}`);
    lines.push(`gamescope: ${status.browser.gamescope ? 'active' : 'inactive'}`);
    if (status.browser.gpu) lines.push(`gpu: ${status.browser.gpu}`);
  } else {
    lines.push(`browser: ${status.browserError ? `error (${status.browserError})` : 'starting'}`);
  }
  if (status.pool) {
    lines.push(`pool: ${status.pool.free} free / ${status.pool.busy} busy (size ${status.pool.size})`);
  }
  lines.push(`queue: ${status.queue.active} active / ${status.queue.pending} pending`);
  return lines.join('\n');
}

async function runFetch(urls, opts, config) {
  await guardRobots(urls, opts);
  const wantLinks = !!opts.links;
  const wantHtml = !!(opts.raw || opts.html);
  const timeout = opts.timeout || config.jobTimeoutMs;
  await withDaemon(config, async (sock) => {
    const responses = await Promise.all(
      urls.map((url) =>
        sendRequest(
          sock,
          { cmd: 'fetch', url, opts: { links: wantLinks, html: wantHtml, timeout } },
          { timeout: requestTimeout(opts, config) },
        ),
      ),
    );
    for (const response of responses) {
      if (!response?.ok) throw toError(response);
    }
    if (wantLinks) {
      const links = responses.flatMap((response) => response.links || []);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, links })}\n`);
      } else {
        process.stdout.write(`${formatLinksMarkdown(links)}\n`);
      }
      return;
    }
    const docs = responses.map((response) => response.doc);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, docs })}\n`);
      return;
    }
    if (wantHtml) {
      const output = docs
        .map((doc) => truncate(doc.html || '', opts.maxChars).trim())
        .filter(Boolean)
        .join('\n\n---\n\n');
      process.stdout.write(`${output}\n`);
      return;
    }
    const output = formatFetchMarkdown(docs, {
      includeFrontmatter: opts.frontmatter !== false,
      maxChars: opts.maxChars,
    });
    process.stdout.write(`${output}\n`);
  });
}

async function runSearch(query, opts, config) {
  await withDaemon(config, async (sock) => {
    const timeout = opts.timeout || config.jobTimeoutMs;
    const response = await sendRequest(
      sock,
      {
        cmd: 'search',
        query,
        opts: { limit: opts.limit || 10, page: opts.page || 1, timeout },
      },
      { timeout: requestTimeout(opts, config) },
    );
    if (!response?.ok) throw toError(response);
    const results = response.results;
    const engine = response.engine || config.searchEngine || 'google';

    let docs = [];
    if (opts.fetch) {
      const fetchLimit = opts.fetchLimit ? int(opts.fetchLimit) : 3;
      const targets = results.slice(0, fetchLimit).map((r) => r.url);
      await guardRobots(targets, opts);
      const fetched = await Promise.all(
        targets.map((url) =>
          sendRequest(
            sock,
            { cmd: 'fetch', url, opts: { timeout } },
            { timeout: requestTimeout(opts, config) },
          ).catch((error) => ({ ok: false, code: error.code, message: error.message })),
        ),
      );
      docs = fetched.filter((r) => r?.ok).map((r) => r.doc);
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, query, engine, results, docs })}\n`);
      return;
    }
    let output = formatSearchMarkdown(results, { query });
    if (docs.length) {
      output += `\n\n---\n\n${formatFetchMarkdown(docs, {
        includeFrontmatter: opts.frontmatter !== false,
        maxChars: opts.maxChars,
      })}`;
    }
    process.stdout.write(`${output}\n`);
  });
}

export function buildProgram() {
  const program = new Command();
  program
    .name('seargine')
    .description('Headful, daemon-backed web search and fetch that returns clean Markdown.')
    .version('1.0.0')
    .option('--config <path>', 'path to config.json')
    .option('--timeout <ms>', 'job timeout in milliseconds', int)
    .option('--json', 'output structured JSON instead of Markdown')
    .option('--quiet', 'suppress diagnostics');

  addCommonOptions(
    program
      .command('search')
      .description('search the web and print results as Markdown')
      .argument('<query>', 'search query')
      .option('--limit <n>', 'maximum number of results', int)
      .option('--page <n>', 'result page number', int)
      .option('--fetch', 'also fetch and append the top result pages')
      .option('--fetch-limit <n>', 'how many result pages to fetch with --fetch', int)
      .option('--max-chars <n>', 'truncate fetched bodies', int)
      .option('--no-frontmatter', 'omit YAML frontmatter from fetched pages')
      .option('--respect-robots', 'skip URLs disallowed by robots.txt'),
  ).action((query, options, command) => {
    const opts = command.optsWithGlobals();
    const config = loadConfig({ configPath: opts.config });
    return execute(opts, () => runSearch(query, opts, config));
  });

  addCommonOptions(
    program
      .command('fetch')
      .description('fetch one or more URLs and print clean Markdown')
      .argument('<urls...>', 'one or more URLs')
      .option('--max-chars <n>', 'truncate the body to n characters', int)
      .option('--raw', 'print the cleaned HTML instead of Markdown')
      .option('--html', 'alias for --raw')
      .option('--links', 'print only links extracted from the page')
      .option('--no-frontmatter', 'omit the YAML frontmatter block')
      .option('--respect-robots', 'skip URLs disallowed by robots.txt'),
  ).action((urls, options, command) => {
    const opts = command.optsWithGlobals();
    const config = loadConfig({ configPath: opts.config });
    return execute(opts, () => runFetch(urls, opts, config));
  });

  addCommonOptions(
    program
      .command('links')
      .description('print only the links found on a page')
      .argument('<url>', 'URL to inspect'),
  ).action((url, options, command) => {
    const opts = command.optsWithGlobals();
    const config = loadConfig({ configPath: opts.config });
    return execute(opts, () => runFetch([url], { ...opts, links: true }, config));
  });

  program
    .command('status')
    .description('show daemon status')
    .option('--json', 'output structured JSON')
    .option('--quiet', 'suppress diagnostics')
    .action((options, command) => {
      const opts = command.optsWithGlobals();
      const config = loadConfig({ configPath: opts.config });
      return execute(opts, async () => {
        const sock = socketPath();
        if (!(await isDaemonAlive(sock))) {
          if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, status: { running: false } })}\n`);
          else process.stdout.write('daemon: stopped\n');
          return;
        }
        const response = await sendRequest(sock, { cmd: 'status' }, { timeout: 5000 });
        if (!response?.ok) throw toError(response);
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, status: response.status })}\n`);
        else process.stdout.write(`${renderStatus(response.status)}\n`);
      });
    });

  program
    .command('stop')
    .description('stop the daemon and browser')
    .option('--json', 'output structured JSON')
    .option('--quiet', 'suppress diagnostics')
    .action((options, command) => {
      const opts = command.optsWithGlobals();
      return execute(opts, async () => {
        const sock = socketPath();
        if (!(await isDaemonAlive(sock))) {
          if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, stopped: false })}\n`);
          else if (!opts.quiet) process.stdout.write('daemon: not running\n');
          return;
        }
        await sendRequest(sock, { cmd: 'stop' }, { timeout: 5000 }).catch(() => {});
        await waitForStopped(sock, 8000);
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, stopped: true })}\n`);
        else if (!opts.quiet) process.stdout.write('daemon stopped\n');
      });
    });

  program
    .command('restart')
    .description('restart the daemon')
    .option('--json', 'output structured JSON')
    .option('--quiet', 'suppress diagnostics')
    .action((options, command) => {
      const opts = command.optsWithGlobals();
      const config = loadConfig({ configPath: opts.config });
      return execute(opts, async () => {
        const sock = socketPath();
        if (await isDaemonAlive(sock)) {
          await sendRequest(sock, { cmd: 'stop' }, { timeout: 5000 }).catch(() => {});
          await waitForStopped(sock, 5000);
        }
        spawnDaemon(config);
        await waitForDaemon(sock, 25000);
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, restarted: true })}\n`);
        else if (!opts.quiet) process.stdout.write('daemon restarted\n');
      });
    });

  return program;
}

export async function run(argv = process.argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
}
