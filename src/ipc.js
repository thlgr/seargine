import net from 'node:net';

// One JSON request per connection, newline-delimited, one JSON response back.
export function sendRequest(sockPath, request, { timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection(sockPath);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error('daemon did not respond in time'), { code: 'TIMEOUT' }));
    }, timeout);
    if (timer.unref) timer.unref();

    if (signal) {
      signal.addEventListener('abort', () => {
        finish(reject, Object.assign(new Error('request aborted'), { code: 'ABORTED' }));
      }, { once: true });
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        try {
          finish(resolve, JSON.parse(line));
        } catch (error) {
          finish(reject, Object.assign(new Error(`bad daemon response: ${error.message}`), { code: 'DAEMON_ERROR' }));
        }
      }
    });
    socket.on('error', (error) => {
      finish(reject, Object.assign(error, { code: error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'DAEMON_DOWN' : 'DAEMON_ERROR' }));
    });
    socket.on('close', () => {
      if (!settled) {
        finish(reject, Object.assign(new Error('daemon closed connection without a response'), { code: 'DAEMON_ERROR' }));
      }
    });
  });
}

export async function isDaemonAlive(sockPath) {
  try {
    const res = await sendRequest(sockPath, { cmd: 'ping' }, { timeout: 2000 });
    return res?.ok === true;
  } catch {
    return false;
  }
}

// Server side: wraps a connection handler that receives the parsed request
// and returns (or resolves to) a response object.
export function createServer(sockPath, onRequest, { logger } = {}) {
  const server = net.createServer((socket) => {
    let buffer = '';
    let handled = false;
    const reply = (response) => {
      if (handled) return;
      handled = true;
      socket.end(JSON.stringify(response) + '\n');
    };
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        reply({ ok: false, code: 'DAEMON_ERROR', message: 'malformed request' });
        return;
      }
      try {
        const response = await onRequest(request, socket);
        reply(response ?? { ok: true });
      } catch (error) {
        logger?.debug?.(`request failed: ${error.stack || error.message}`);
        reply({ ok: false, code: error.code || 'DAEMON_ERROR', message: error.message });
      }
    });
    socket.on('error', () => {});
  });
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
