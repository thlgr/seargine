import { collectGotoMap } from './google-goto.js';

function googleSearchUrl(query, limit, pageNum) {
  const params = new URLSearchParams({
    q: query,
    num: String(Math.min(limit, 30)),
    hl: 'en',
    start: String((pageNum - 1) * limit),
  });
  return `https://www.google.com/search?${params.toString()}`;
}

function duckSearchUrl(query, pageNum, limit) {
  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  if (pageNum > 1) params.set('s', String((pageNum - 1) * limit));
  return `https://html.duckduckgo.com/html/?${params.toString()}`;
}

async function dismissConsent(page) {
  const hasConsent =
    /consent\.google|\/consent|before you continue/i.test(page.url()) ||
    (await page.$('#L2AGLb, form[action*="consent"], button[aria-label*="Accept all"], button[aria-label*="I agree"]').catch(() => null));
  if (!hasConsent) return;
  const button = await page
    .$('#L2AGLb, button[aria-label*="Accept all"], button[aria-label*="I agree"], form[action*="consent"] button, button[jsname="b3VHJd"]')
    .catch(() => null);
  if (!button) return;
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    button.click().catch(() => {}),
  ]);
}

async function isGoogleBlocked(page) {
  if (/\/sorry\//.test(page.url())) return true;
  return page
    .evaluate(() =>
      /unusual traffic|detected unusual traffic|systems have detected|our systems have detected/i.test(
        document.body?.innerText || '',
      ),
    )
    .catch(() => false);
}

async function extractGoogleResults(page) {
  // Class names on Google are obfuscated and change often, so this only relies
  // on semantics: title = <h3> inside an <a>, domain = <cite>, snippet = first
  // sizeable text run outside any link/cite. Links are /goto?url=<opaque>, so
  // the raw href and <cite> are returned and the destination is resolved later.
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();

    // Climb to the largest ancestor that still contains exactly this one result
    // (more than one <h3> means we left the block).
    const findContainer = (anchor) => {
      let node = anchor.parentElement;
      let candidate = anchor;
      while (node) {
        if (node.querySelectorAll('h3').length > 1) break;
        candidate = node;
        node = node.parentElement;
      }
      return candidate;
    };

    const findSnippet = (container, title) => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || parent.closest('a, h3, cite, script, style')) continue;
        const text = clean(parent.textContent);
        if (text.length >= 40 && text.length <= 1000 && text !== title) return text;
      }
      return '';
    };

    for (const anchor of document.querySelectorAll('a')) {
      const heading = anchor.querySelector('h3');
      if (!heading) continue;
      const title = clean(heading.textContent);
      if (!title) continue;
      const href = anchor.getAttribute('href') || '';
      const container = findContainer(anchor);
      const cite = clean(container.querySelector('cite')?.textContent);
      const snippet = findSnippet(container, title);
      const key = `${title}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, href, cite, snippet });
    }
    return out;
  });
}

function isGoogleHost(url) {
  try {
    return /(^|\.)google\.[a-z.]+$/i.test(new URL(url).hostname) || /(^|\.)googleusercontent\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function normalizeCite(cite) {
  if (!cite) return null;
  // Google elides long cites ("example.com › docs › getting-sta..."); rebuilding
  // a path from one points at a page that does not exist, so drop it instead.
  if (/\.{3}|\u2026/.test(cite)) return null;
  const cleaned = cite.replace(/\s*[›»]\s*/g, '/').replace(/\s+/g, '');
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(cleaned)) return `https://${cleaned}`;
  return null;
}

function gotoToken(href) {
  try {
    const url = new URL(href, 'https://www.google.com');
    if (url.pathname === '/goto') return url.searchParams.get('url') || '';
  } catch {
    /* fall through */
  }
  return null;
}

// The /goto endpoint replies with a 302 to the real destination. Used only for
// keys the page-state decoder could not resolve.
async function resolveGoogleHref(href) {
  try {
    const url = new URL(href, 'https://www.google.com');
    if (url.pathname === '/url') {
      return url.searchParams.get('q') || url.searchParams.get('url') || null;
    }
    if (url.pathname !== '/goto') return null;
    const res = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return res.headers.get('location') || null;
  } catch {
    return null;
  }
}

// Prefer destinations decoded from page state (no requests); fall back to the
// /goto redirect, then to <cite>.
async function resolveGoogleLinks(items, gotoMap) {
  const unresolved = [];
  for (const item of items) {
    const href = item.href || '';
    if (/^https?:\/\//i.test(href)) {
      item.url = href;
      continue;
    }
    const token = gotoToken(href);
    const decoded = token ? gotoMap?.[token] : null;
    if (decoded) item.url = decoded;
    else unresolved.push(item);
  }
  await Promise.all(
    unresolved.map(async (item) => {
      item.url = (await resolveGoogleHref(item.href)) || normalizeCite(item.cite) || '';
    }),
  );
  return items
    .filter((item) => /^https?:\/\//i.test(item.url) && !isGoogleHost(item.url))
    .map(({ title, url, snippet }) => ({ title, url, snippet }));
}

function decodeDuckUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    if (/duckduckgo\.com$/.test(url.hostname) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return url.toString();
  } catch {
    return href;
  }
}

async function extractDuckResults(page) {
  return page.evaluate(() => {
    const out = [];
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    for (const block of document.querySelectorAll('.result')) {
      if (block.classList.contains('result--ad')) continue;
      const anchor = block.querySelector('a.result__a');
      if (!anchor) continue;
      const snippet = block.querySelector('.result__snippet');
      out.push({ title: clean(anchor.innerText), url: anchor.href, snippet: clean(snippet?.innerText) });
    }
    return out;
  });
}

async function searchGoogle(page, query, { limit, pageNum, timeout, logger, signal }) {
  const run = async () => {
    await page.goto(googleSearchUrl(query, limit, pageNum), { waitUntil: 'domcontentloaded', timeout });
    await dismissConsent(page);
    // Result heading links are semantic and appear as soon as results render.
    await page.waitForSelector('a h3', { timeout: 5000 }).catch(() => {});
    if (signal?.aborted) throw Object.assign(new Error('search aborted'), { code: 'TIMEOUT' });
    return extractGoogleResults(page);
  };

  let items = await run();
  // Cold profile / consent / block: warm up once on the homepage and retry.
  if (items.length === 0 || (await isGoogleBlocked(page))) {
    await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await dismissConsent(page);
    items = await run();
  }
  if (await isGoogleBlocked(page)) {
    throw Object.assign(new Error('google blocked the search request'), { code: 'NO_RESULTS' });
  }

  // Decode the opaque /goto keys from the page state (no redirect requests).
  const gotoMap = await page.evaluate(collectGotoMap).catch(() => ({}));
  const results = await resolveGoogleLinks(items, gotoMap);
  if (results.length === 0) {
    logger?.debug?.(
      `google returned 0 results (title="${await page.title().catch(() => '')}", url=${page.url()}, blocked=${await isGoogleBlocked(page)})`,
    );
  }
  return results;
}

async function searchDuck(page, query, { limit, pageNum, timeout, logger, signal }) {
  await page.goto(duckSearchUrl(query, pageNum, limit), { waitUntil: 'domcontentloaded', timeout });
  await page.waitForSelector('a.result__a, .result', { timeout: 5000 }).catch(() => {});
  if (signal?.aborted) throw Object.assign(new Error('search aborted'), { code: 'TIMEOUT' });
  const raw = await extractDuckResults(page);
  return raw
    .map((item) => ({ title: item.title, url: decodeDuckUrl(item.url), snippet: item.snippet }))
    .filter((item) => /^https?:\/\//i.test(item.url));
}

export async function searchWeb(page, query, opts, config, signal) {
  const limit = Math.max(1, Math.min(30, opts.limit || 10));
  const pageNum = Math.max(1, opts.page || 1);
  const engine = config.searchEngine || 'google';
  const timeout = opts.timeout && opts.timeout > 0 ? opts.timeout : config.jobTimeoutMs || 30000;
  const context = { limit, pageNum, timeout, logger: opts.logger, signal };

  const engines = engine === 'duckduckgo' ? ['duckduckgo'] : ['google', 'duckduckgo'];
  let lastError = null;
  let sawBlock = false;

  for (const name of engines) {
    try {
      const results = name === 'google' ? await searchGoogle(page, query, context) : await searchDuck(page, query, context);
      if (results.length > 0) return { engine: name, results: results.slice(0, limit) };
      lastError = Object.assign(new Error(`no results for "${query}"`), { code: 'NO_RESULTS' });
    } catch (error) {
      lastError = error;
      if (error.code === 'NO_RESULTS') sawBlock = true;
      opts.logger?.debug?.(`${name} search failed: ${error.message}`);
    }
  }

  const message = sawBlock
    ? `search engines returned no results for "${query}" (google may be rate-limiting)`
    : lastError?.message || `no results for "${query}"`;
  throw Object.assign(new Error(message), { code: lastError?.code === 'CAPTCHA_UNSUPPORTED' ? lastError.code : 'NO_RESULTS' });
}
