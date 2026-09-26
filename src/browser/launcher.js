import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { profileDir } from '../config.js';

// Launch strategy: spawn the system browser with as few flags as possible
// (only the remote debugging port and a user-data-dir) and connect over CDP.
// Puppeteer's default flag set is itself a fingerprint, so we avoid it. The
// dedicated profile is seeded from the user's real browser profile (cookies +
// encryption key) so that sessions/cookies are reused and anti-bot systems see
// a normal, trusted user.

const CHROME_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  // Brave is Chromium-based; kept as a last-resort fallback for systems
  // without Chrome/Chromium installed.
  'brave',
  'brave-browser',
];

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function which(name) {
  if (!name) return null;
  if (name.includes(path.sep)) {
    return fs.existsSync(name) ? name : null;
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function findChrome(config = {}) {
  if (config.chromePath) {
    const resolved = which(config.chromePath) || (fs.existsSync(config.chromePath) ? config.chromePath : null);
    if (resolved) return resolved;
    const error = new Error(`configured chromePath not found: ${config.chromePath}`);
    error.code = 'CHROME_NOT_FOUND';
    throw error;
  }
  if (process.platform === 'darwin') {
    for (const p of MAC_PATHS) if (fs.existsSync(p)) return p;
  }
  for (const name of CHROME_CANDIDATES) {
    const found = which(name);
    if (found) return found;
  }
  const error = new Error(
    'no Chrome/Chromium binary found; install Google Chrome or set chromePath in config',
  );
  error.code = 'CHROME_NOT_FOUND';
  throw error;
}

function brandOf(chromePath) {
  if (/brave/i.test(chromePath)) return 'brave';
  if (/chromium/i.test(chromePath)) return 'chromium';
  return 'chrome';
}

function realProfilePaths(brand) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return {
      brave: path.join(base, 'BraveSoftware', 'Brave-Browser'),
      chromium: path.join(base, 'Chromium'),
      chrome: path.join(base, 'Google', 'Chrome'),
    }[brand];
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return {
      brave: path.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      chromium: path.join(base, 'Chromium', 'User Data'),
      chrome: path.join(base, 'Google', 'Chrome', 'User Data'),
    }[brand];
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    brave: path.join(base, 'BraveSoftware', 'Brave-Browser'),
    chromium: path.join(base, 'chromium'),
    chrome: path.join(base, 'google-chrome'),
  }[brand];
}

// Copy the minimal set of files needed to inherit the real session: the cookie
// store and the key material that decrypts it. The rest of the profile stays
// untouched (no extensions, history, etc.).
export function seedProfile(sourceDir, targetDir, logger) {
  if (!sourceDir || !fs.existsSync(sourceDir) || sourceDir === targetDir) return false;
  const files = [
    'Local State',
    path.join('Default', 'Cookies'),
    path.join('Default', 'Preferences'),
  ];
  let copied = 0;
  for (const rel of files) {
    const from = path.join(sourceDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    } catch (error) {
      logger?.debug?.(`profile seed skipped ${rel}: ${error.message}`);
    }
  }
  if (copied > 0) logger?.info(`seeded browser profile from ${sourceDir} (${copied} files)`);
  return copied > 0;
}

export function resolveDisplayMode(config = {}) {
  const setting = config.gamescope || 'auto';
  if (process.platform !== 'linux' || setting === 'off') {
    return { mode: 'direct', reason: setting === 'off' ? 'config:off' : 'not-linux' };
  }
  const gamescope = which('gamescope');
  if (setting === 'on' && !gamescope) {
    const error = new Error('gamescope forced via config but binary not found in PATH');
    error.code = 'GAMESCOPE_MISSING';
    throw error;
  }
  if (gamescope) return { mode: 'gamescope', binary: gamescope };
  const xvfb = which('xvfb-run');
  if (xvfb) return { mode: 'xvfb', binary: xvfb };
  return { mode: 'direct', reason: 'gamescope-not-found' };
}

function readSysfs(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

export function listGpus(drmDir = '/sys/class/drm') {
  let entries;
  try {
    entries = fs.readdirSync(drmDir);
  } catch {
    return [];
  }
  const gpus = [];
  for (const name of entries.filter((n) => /^renderD\d+$/.test(n)).sort()) {
    const device = path.join(drmDir, name, 'device');
    const vendor = readSysfs(path.join(device, 'vendor'));
    const id = readSysfs(path.join(device, 'device'));
    if (!vendor || !id) continue;
    const sysfs = fs.realpathSync(device);
    gpus.push({
      address: path.basename(sysfs),
      vendor: vendor.replace(/^0x/, ''),
      device: id.replace(/^0x/, ''),
      bootVga: readSysfs(path.join(device, 'boot_vga')) === '1',
      sysfs,
    });
  }
  return gpus;
}

// Intel iGPUs always sit on the root PCI bus (00:02.0); discrete Arc cards
// never do. amdgpu only exposes the "vddnb" voltage sensor on APUs.
function isIntegrated(gpu) {
  if (gpu.vendor === '8086') return /^[0-9a-f]+:00:/.test(gpu.address);
  if (gpu.vendor === '1002') {
    const hwmon = path.join(gpu.sysfs, 'hwmon');
    let dirs = [];
    try {
      dirs = fs.readdirSync(hwmon);
    } catch {
      return false;
    }
    return dirs.some((dir) => readSysfs(path.join(hwmon, dir, 'in1_label')) === 'vddnb');
  }
  return false;
}

export function findIntegratedGpu(gpus = listGpus()) {
  const integrated = gpus.filter(isIntegrated);
  return integrated.find((gpu) => gpu.bootVga) || integrated[0] || null;
}

// Point every layer that picks a GPU at the same device: Mesa's OpenGL and
// Vulkan device selection, and NVIDIA's PRIME offload, which would otherwise
// win when seargine was started from a prime-run shell.
function gpuEnv(gpu) {
  const env = { ...process.env };
  delete env.__NV_PRIME_RENDER_OFFLOAD;
  delete env.__NV_PRIME_RENDER_OFFLOAD_PROVIDER;
  env.DRI_PRIME = `pci-${gpu.address.replace(/[:.]/g, '_')}`;
  env.MESA_VK_DEVICE_SELECT = `${gpu.vendor}:${gpu.device}`;
  env.__GLX_VENDOR_LIBRARY_NAME = 'mesa';
  env.__VK_LAYER_NV_optimus = 'non_NVIDIA_only';
  return env;
}

export function buildChromeArgs(config, port) {
  const { width, height } = config.viewport || { width: 1280, height: 800 };
  const userDataDir = config.userDataDir || profileDir();
  // Keep this list as close to a stock launch as possible.
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
  ];
  if (config.userAgent) args.push(`--user-agent=${config.userAgent}`);
  // Window flags only apply to a real desktop window. Under gamescope the
  // nested compositor already controls the size, and passing them can make the
  // browser detach from gamescope.
  if (resolveDisplayMode(config).mode !== 'gamescope') {
    const mode = config.windowMode || 'maximized';
    if (mode === 'fullscreen') args.push('--start-fullscreen');
    else if (mode === 'maximized') args.push('--start-maximized');
    else if (mode === 'default') args.push(`--window-size=${width},${height}`);
  }
  return args;
}

export function buildCommand(config, port) {
  const chrome = findChrome(config);
  const display = resolveDisplayMode(config);
  const chromeArgs = buildChromeArgs(config, port);
  const { width, height } = config.viewport || { width: 1280, height: 800 };

  if (display.mode === 'gamescope') {
    // Headless backend gives Chrome a real display/compositor without a window
    // on the desktop environment, so it stays 100% headful to fingerprinting.
    const gpu = config.gamescopeIgpu === false ? null : findIntegratedGpu();
    const gpuArgs = gpu ? ['--prefer-vk-device', `${gpu.vendor}:${gpu.device}`] : [];
    return {
      command: display.binary,
      args: ['--backend', 'headless', ...gpuArgs, '-W', String(width), '-H', String(height), '--', chrome, ...chromeArgs],
      env: gpu ? gpuEnv(gpu) : { ...process.env },
      chrome,
      display,
      gpu,
    };
  }
  if (display.mode === 'xvfb') {
    return {
      command: display.binary,
      args: ['-a', '--server-args', `-screen 0 ${width}x${height}x24`, chrome, ...chromeArgs],
      env: { ...process.env },
      chrome,
      display,
      gpu: null,
    };
  }
  return { command: chrome, args: chromeArgs, env: { ...process.env }, chrome, display, gpu: null };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDevTools(port, child, timeoutMs, logger) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) {
      const error = new Error(`browser exited before devtools was ready: ${stderrTail.trim()}`);
      error.code = 'LAUNCH_FAILED';
      throw error;
    }
    try {
      const res = await fetch(endpoint);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  logger?.debug?.(stderrTail.slice(-500));
  const error = new Error(`browser devtools endpoint timed out after ${timeoutMs}ms`);
  error.code = 'TIMEOUT';
  throw error;
}

export async function launchBrowser(config, logger) {
  const chrome = findChrome(config);
  const port = await getFreePort();

  const usingDedicated = !config.userDataDir;
  if (usingDedicated && config.seedProfile !== false) {
    const source =
      config.seedProfileFrom === false
        ? null
        : config.seedProfileFrom || realProfilePaths(brandOf(chrome));
    if (source) {
      try {
        seedProfile(source, profileDir(), logger);
      } catch (error) {
        logger?.debug?.(`profile seed failed: ${error.message}`);
      }
    }
  }

  const { command, args, env, display, gpu } = buildCommand(config, port);
  const gpuLabel = gpu ? `${gpu.vendor}:${gpu.device} at ${gpu.address}` : null;
  logger?.info(`launching browser: ${command} (display=${display.mode}, port=${port}${gpu ? `, gpu=${gpuLabel}` : ''})`);
  if (display.mode === 'gamescope' && !gpu && config.gamescopeIgpu !== false) {
    logger?.info('no integrated GPU found; gamescope picks its own');
  }

  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Own process group so we can tear down gamescope + Chrome together.
    detached: true,
    env,
  });
  child.on('error', (error) => logger?.error(`browser spawn error: ${error.message}`));

  let browser;
  try {
    await waitForDevTools(port, child, 20000, logger);
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      // Let the real window size drive layout; avoid viewport emulation which
      // can be detected via outerWidth/innerWidth mismatches.
      defaultViewport: null,
    });
  } catch (error) {
    // Kill the whole process group so a detached Chrome does not survive and
    // keep the profile locked.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
    throw error;
  }

  const stopped = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      logger?.info(`browser process exited (code=${code}, signal=${signal})`);
      resolve();
    });
  });

  return {
    browser,
    process: child,
    pid: child.pid,
    port,
    chrome,
    display: display.mode,
    gamescope: display.mode === 'gamescope',
    gpu: gpuLabel,
    stopped,
    async close() {
      try { await browser.disconnect(); } catch {}
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
    },
  };
}

export { getFreePort };
