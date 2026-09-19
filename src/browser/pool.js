// Pool of persistent, recycled tabs. Tabs are never closed per request:
// after a job the page is reset (about:blank) and returned to the LRU end of
// the free list. Only idle shrinking actually closes tabs.
export class TabPool {
  constructor({ browser, size, config, logger }) {
    this.browser = browser;
    this.size = Math.max(1, size);
    this.config = config;
    this.logger = logger;
    this.free = [];
    this.busy = new Set();
    this.waiters = [];
    this.closed = false;
  }

  get total() {
    return this.free.length + this.busy.size;
  }

  async init() {
    for (let i = 0; i < this.size; i += 1) {
      const page = await this._createTab();
      this.free.push(page);
    }
    this.logger?.debug?.(`pool ready: ${this.size} tabs`);
  }

  async _createTab() {
    const page = await this.browser.newPage();
    page.setDefaultTimeout(this.config.jobTimeoutMs || 30000);
    page.setDefaultNavigationTimeout(this.config.jobTimeoutMs || 30000);
    // Deterministic, non-interactive behaviour: dismiss dialogs quietly.
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('pageerror', () => {});
    return page;
  }

  async _replace(page) {
    try {
      await page.close().catch(() => {});
    } catch {}
    return this._createTab();
  }

  acquire() {
    if (this.closed) return Promise.reject(Object.assign(new Error('pool closed'), { code: 'DAEMON_ERROR' }));
    if (this.free.length > 0) {
      // free[] is ordered least-recently-released first => LRU assignment.
      const page = this.free.shift();
      this.busy.add(page);
      return Promise.resolve(page);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async release(page) {
    if (this.closed) return;
    this.busy.delete(page);
    let usable = page;
    try {
      await page.evaluate(() => window.stop()).catch(() => {});
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
    } catch {
      this.logger?.debug?.('recycling tab after reset failure');
      usable = await this._replace(page);
    }
    if (this.closed) {
      await usable.close().catch(() => {});
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      this.busy.add(usable);
      waiter(usable);
    } else {
      this.free.push(usable);
    }
  }

  // Close only free tabs beyond `target`. Never touches busy tabs.
  async shrink(target) {
    const desired = Math.max(1, target);
    while (this.free.length > 0 && this.total > desired) {
      const page = this.free.pop();
      await page.close().catch(() => {});
      this.logger?.debug?.(`pool shrunk to ${this.total}`);
    }
    this.size = this.total;
  }

  async grow(target) {
    while (this.total < target) {
      const page = await this._createTab();
      this.free.push(page);
    }
    this.size = this.total;
  }

  stats() {
    return {
      size: this.total,
      free: this.free.length,
      busy: this.busy.size,
    };
  }

  async close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(Promise.reject(Object.assign(new Error('pool closed'), { code: 'DAEMON_ERROR' })));
    }
    const pages = [...this.free, ...this.busy];
    this.free = [];
    this.busy.clear();
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
  }
}
