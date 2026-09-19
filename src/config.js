import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  chromePath: null,
  // null => dedicated profile at ~/.config/seargine/chrome-profile.
  // Point this at your real Chrome/Brave profile to reuse sessions/cookies
  // (the browser must not already be running with that profile).
  userDataDir: null,
  // Seed the dedicated profile with cookies + key from the real browser
  // profile, so the fresh profile inherits your trusted session.
  seedProfile: true,
  // null => auto-detect the real profile from the chosen browser.
  // false => disable. A path => use that profile as the seed source.
  seedProfileFrom: null,
  poolSize: 3,
  gamescope: 'auto',
  // null => use the browser's real user agent (recommended).
  userAgent: null,
  // 'maximized' (recommended), 'fullscreen', or 'default'.
  windowMode: 'maximized',
  viewport: { width: 1280, height: 800 },
  perDomainRateMs: 1500,
  jobTimeoutMs: 30000,
  idleShrinkMs: 120000,
  idleShutdownMs: 600000,
  searchEngine: 'google',
  maxCharsDefault: null,
};

export function dataDir() {
  if (process.env.WEB_FETCH_HOME) return process.env.WEB_FETCH_HOME;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'seargine');
}

export function defaultConfigPath() {
  return path.join(dataDir(), 'config.json');
}

export function socketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const dir = runtime && fs.existsSync(runtime) ? runtime : os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(dir, `seargine-${uid}.sock`);
}

export function profileDir() {
  return path.join(dataDir(), 'chrome-profile');
}

export function logPath() {
  return path.join(dataDir(), 'seargine.log');
}

export function pidPath() {
  return path.join(dataDir(), 'seargine.pid');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig({ configPath, overrides } = {}) {
  const file = configPath || defaultConfigPath();
  let fromFile = {};
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`invalid config at ${file}: ${error.message}`);
    }
  }
  const config = deepMerge(deepMerge(DEFAULTS, fromFile), overrides);
  config._configPath = file;
  return config;
}

export function ensureDataDirs() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(profileDir(), { recursive: true });
}

export { deepMerge };
