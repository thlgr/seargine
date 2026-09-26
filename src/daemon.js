import fs from 'node:fs';
import {
  loadConfig,
  socketPath,
  pidPath,
  logPath,
  ensureDataDirs,
} from './config.js';
import { createServer, isDaemonAlive } from './ipc.js';
import { JobQueue } from './browser/queue.js';
import { TabPool } from './browser/pool.js';
import { launchBrowser } from './browser/launcher.js';
import { fetchUrl, normalizeUrl } from './fetch.js';
import { searchWeb } from './search.js';

function createLogger({ file, quiet = false }) {
  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] ${level} ${message}`;
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never crash the daemon */
    }
    if (!quiet && level !== 'debug') process.stderr.write(`${line}\n`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export class Daemon {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.socketPath = socketPath();
    this.startedAt = Date.now();
    this.launch = null;
    this.pool = null;
    this.browserReady = null;
    this.browserError = null;
    this.shuttingDown = false;
    this.shrinkTimer = null;
    this.shutdownTimer = null;
  }

  async start() {
    ensureDataDirs();
    this.queue = new JobQueue({
      concurrency: this.config.poolSize,
      minIntervalMs: this.config.perDomainRateMs,
      logger: this.logger,
    });
    this.server = createServer(this.socketPath, (request) => this.handleRequest(request), {
      logger: this.logger,
    });
    await this.server.listen();
    fs.writeFileSync(pidPath(), String(process.pid));
    this.logger.info(`daemon listening on ${this.socketPath} (pid ${process.pid})`);

    // Keep the browser warm eagerly; jobs await browserReady.
    this.browserReady = this._initBrowser().catch((error) => {
      this.browserError = error;
      this.browserReady = null;
      this.logger.error(`browser init failed: ${error.message}`);
    });
    this.touch();
    return this;
  }

  async _initBrowser() {
    this.launch = await launchBrowser(this.config, this.logger);
    this.pool = new TabPool({
      browser: this.launch.browser,
      size: this.config.poolSize,
      config: this.config,
      logger: this.logger,
    });
    await this.pool.init();
    this.queue.setConcurrency(this.pool.stats().size);
    this.browserError = null;
    this.logger.info(
      `browser ready (pid ${this.launch.pid}, display=${this.launch.display}, tabs=${this.pool.stats().size})`,
    );
    this.launch.stopped.then(() => {
      this.logger.error('browser process died; it will be relaunched on demand');
      this.pool = null;
      this.launch = null;
      this.browserReady = null;
    });
    return this.pool;
  }

  async ensureBrowser() {
    if (this.browserReady) {
      try {
        await this.browserReady;
      } catch (error) {
        this.browserReady = null;
        throw error;
      }
    }
    if (!this.pool) {
      this.browserReady = this._initBrowser().catch((error) => {
        this.browserError = error;
        this.browserReady = null;
        throw error;
      });
      await this.browserReady;
    }
    return this.pool;
  }

  async handleRequest(request) {
    const cmd = request?.cmd;
    switch (cmd) {
      case 'ping':
        return { ok: true, pid: process.pid };
      case 'status':
        return { ok: true, status: this.status() };
      case 'stop':
        this.scheduleShutdown();
        return { ok: true, stopped: true };
      case 'fetch':
        this.touch();
        return this.handleFetch(request);
      case 'links':
        this.touch();
        return this.handleFetch({ ...request, opts: { ...request.opts, links: true } });
      case 'search':
        this.touch();
        return this.handleSearch(request);
      default:
        return { ok: false, code: 'BAD_REQUEST', message: `unknown command: ${cmd}` };
    }
  }

  async handleFetch(request) {
    const url = normalizeUrl(request.url);
    const links = !!request.opts?.links;
    const timeout = request.opts?.timeout || this.config.jobTimeoutMs;
    const key = `fetch:${links ? 'links' : 'page'}:${url}`;
    return this.queue.run({
      key,
      host: hostOf(url),
      priority: !!request.opts?.priority,
      timeout,
      task: async (signal) => {
        const pool = await this.ensureBrowser();
        const page = await pool.acquire();
        try {
          const doc = await fetchUrl(
            page,
            url,
            { links, html: !!request.opts?.html, timeout, logger: this.logger },
            this.config,
            signal,
          );
          if (links) return { ok: true, url: doc.url, links: doc.links };
          return { ok: true, doc };
        } finally {
          await pool.release(page).catch((error) => this.logger.debug(`release failed: ${error.message}`));
        }
      },
    });
  }

  async handleSearch(request) {
    const query = String(request.query || '').trim();
    if (!query) return { ok: false, code: 'BAD_REQUEST', message: 'empty query' };
    const limit = request.opts?.limit || 10;
    const pageNum = request.opts?.page || 1;
    const timeout = request.opts?.timeout || this.config.jobTimeoutMs;
    const engine = this.config.searchEngine || 'google';
    const key = `search:${engine}:${query}:${limit}:${pageNum}`;
    return this.queue.run({
      key,
      host: `search:${engine}`,
      priority: !!request.opts?.priority,
      timeout,
      task: async (signal) => {
        const pool = await this.ensureBrowser();
        const page = await pool.acquire();
        try {
          const { engine: usedEngine, results } = await searchWeb(
            page,
            query,
            { limit, page: pageNum, timeout, logger: this.logger },
            this.config,
            signal,
          );
          return { ok: true, query, engine: usedEngine, results };
        } finally {
          await pool.release(page).catch((error) => this.logger.debug(`release failed: ${error.message}`));
        }
      },
    });
  }

  status() {
    return {
      running: true,
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      socket: this.socketPath,
      configPath: this.config._configPath,
      browser: this.launch
        ? {
            pid: this.launch.pid,
            chrome: this.launch.chrome,
            display: this.launch.display,
            gamescope: this.launch.gamescope,
            gpu: this.launch.gpu,
          }
        : null,
      browserError: this.browserError ? this.browserError.message : null,
      pool: this.pool ? this.pool.stats() : null,
      queue: this.queue ? this.queue.stats() : { active: 0, pending: 0, concurrency: 0 },
    };
  }

  touch() {
    this.lastActivity = Date.now();
    this._resetIdleTimers();
  }

  _resetIdleTimers() {
    if (this.shrinkTimer) clearTimeout(this.shrinkTimer);
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    if (this.shuttingDown) return;
    const { idleShrinkMs, idleShutdownMs } = this.config;
    if (idleShrinkMs > 0) {
      this.shrinkTimer = setTimeout(() => this._onIdleShrink(), idleShrinkMs);
    }
    if (idleShutdownMs > 0) {
      this.shutdownTimer = setTimeout(() => this._onIdleShutdown(), idleShutdownMs);
    }
  }

  _onIdleShrink() {
    if (!this.queue.idle) return this.touch();
    if (this.pool && this.pool.stats().size > 1) {
      this.pool
        .shrink(1)
        .then(() => this.queue.setConcurrency(this.pool.stats().size))
        .catch((error) => this.logger.debug(`shrink failed: ${error.message}`));
    }
    return undefined;
  }

  _onIdleShutdown() {
    if (!this.queue.idle) return this.touch();
    this.logger.info('idle timeout reached, shutting down');
    return this.shutdown('idle');
  }

  scheduleShutdown() {
    setTimeout(() => this.shutdown('request'), 150).unref?.();
  }

  async shutdown(reason = 'manual') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info(`shutting down (${reason})`);
    if (this.shrinkTimer) clearTimeout(this.shrinkTimer);
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.queue?.close();
    try {
      await this.pool?.close();
    } catch (error) {
      this.logger.debug(`pool close failed: ${error.message}`);
    }
    try {
      await this.launch?.close();
    } catch (error) {
      this.logger.debug(`browser close failed: ${error.message}`);
    }
    try {
      await this.server?.close();
    } catch {}
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
    try {
      fs.unlinkSync(pidPath());
    } catch {}
    process.exit(0);
  }
}

export async function startDaemon({ quiet = false } = {}) {
  const config = loadConfig({ configPath: process.env.WEB_FETCH_CONFIG || undefined });
  const logger = createLogger({ file: logPath(), quiet });
  const sock = socketPath();

  if (await isDaemonAlive(sock)) {
    process.stderr.write('seargine daemon already running\n');
    process.exit(0);
  }
  try {
    fs.unlinkSync(sock);
  } catch {
    /* stale socket */
  }

  const daemon = new Daemon(config, logger);
  process.on('SIGTERM', () => daemon.shutdown('sigterm'));
  process.on('SIGINT', () => daemon.shutdown('sigint'));
  process.on('uncaughtException', (error) => logger.error(`uncaught exception: ${error.stack || error}`));
  process.on('unhandledRejection', (error) => logger.error(`unhandled rejection: ${error?.stack || error}`));

  await daemon.start();
  return daemon;
}
