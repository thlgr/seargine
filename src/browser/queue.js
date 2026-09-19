// Job queue with concurrency control, per-domain rate limiting, priority and
// in-flight deduplication. A job is dispatched only when a worker slot is free
// AND the host's minimum interval has elapsed.
export class JobQueue {
  constructor({ concurrency = 1, minIntervalMs = 0, logger } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.logger = logger;
    this.pending = [];
    this.active = new Map();
    this.byKey = new Map();
    this.hostLast = new Map();
    this.seq = 0;
    this.timer = null;
    this.closed = false;
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, n);
    this._pump();
  }

  run({ key, host = '', priority = false, timeout, task }) {
    if (this.closed) {
      const error = new Error('queue is shutting down');
      error.code = 'DAEMON_ERROR';
      return Promise.reject(error);
    }
    const existing = this.byKey.get(key);
    if (existing) {
      this.logger?.debug?.(`dedupe: joining in-flight job ${key}`);
      return existing.promise;
    }
    const job = {
      id: ++this.seq,
      key,
      host: host || key,
      priority,
      timeout,
      task,
      promise: null,
      resolve: null,
      reject: null,
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    // Avoid unhandled rejection warnings for waiters that are never awaited.
    job.promise.catch(() => {});
    this.byKey.set(key, job);
    if (priority) this.pending.unshift(job);
    else this.pending.push(job);
    this._pump();
    return job.promise;
  }

  _firstEligible(now) {
    for (let i = 0; i < this.pending.length; i += 1) {
      const job = this.pending[i];
      const readyAt = (this.hostLast.get(job.host) || 0) + this.minIntervalMs;
      if (readyAt <= now) return i;
    }
    return -1;
  }

  _pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const now = Date.now();
      const idx = this._firstEligible(now);
      if (idx === -1) break;
      const [job] = this.pending.splice(idx, 1);
      this._start(job);
    }
    if (this.pending.length > 0 && this.active.size < this.concurrency) {
      // Nothing eligible right now: wake up when the earliest host frees up.
      let wait = Infinity;
      const now = Date.now();
      for (const job of this.pending) {
        const readyAt = (this.hostLast.get(job.host) || 0) + this.minIntervalMs;
        if (readyAt - now < wait) wait = readyAt - now;
      }
      if (Number.isFinite(wait)) {
        this.timer = setTimeout(() => this._pump(), Math.max(5, wait) + 5);
        this.timer.unref?.();
      }
    }
  }

  _start(job) {
    this.active.set(job.id, job);
    this.hostLast.set(job.host, Date.now());
    this.logger?.debug?.(`dispatch #${job.id} host=${job.host} queue=${this.pending.length} active=${this.active.size}`);
    const controller = new AbortController();
    const timeoutMs = job.timeout && job.timeout > 0 ? job.timeout : 0;
    let timer = null;
    const timed = timeoutMs
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = new Error(`job timed out after ${timeoutMs}ms`);
            error.code = 'TIMEOUT';
            reject(error);
          }, timeoutMs);
        })
      : null;

    const work = Promise.resolve().then(() => job.task(controller.signal));
    const raced = timed ? Promise.race([work, timed]) : work;
    raced
      .then((result) => this._settle(job, null, result))
      .catch((error) => this._settle(job, error))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  _settle(job, error, result) {
    this.active.delete(job.id);
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
    if (error) job.reject(error);
    else job.resolve(result);
    this._pump();
  }

  get idle() {
    return this.active.size === 0 && this.pending.length === 0;
  }

  stats() {
    return {
      active: this.active.size,
      pending: this.pending.length,
      concurrency: this.concurrency,
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const job of this.pending.splice(0)) {
      const error = new Error('daemon shutting down');
      error.code = 'DAEMON_ERROR';
      if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
      job.reject(error);
    }
  }
}
