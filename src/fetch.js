import { parseHTML } from 'linkedom';
import defuddleModule from 'defuddle/node';
import { handleCloudflare } from './browser/cloudflare.js';

const { Defuddle } = defuddleModule;

export function normalizeUrl(input) {
  if (!input || typeof input !== 'string') {
    throw Object.assign(new Error('missing url'), { code: 'BAD_URL' });
  }
  let value = input.trim();
  if (value === '') throw Object.assign(new Error('empty url'), { code: 'BAD_URL' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      throw Object.assign(new Error(`unsupported scheme in url: ${value}`), { code: 'BAD_URL' });
    }
    value = `https://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error(`invalid url: ${input}`), { code: 'BAD_URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`unsupported scheme: ${parsed.protocol}`), { code: 'BAD_URL' });
  }
  return parsed.toString();
}

export async function extractLinks(page, url) {
  const links = await page.evaluate(() => {
    const out = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.href;
      if (!href || /^(javascript:|mailto:|tel:|data:)/i.test(href)) continue;
      const text = (anchor.innerText || anchor.textContent || '').trim().replace(/\s+/g, ' ');
      out.push({ url: href, text: text.slice(0, 200) });
    }
    return out;
  });
  const seen = new Set();
  const deduped = [];
  for (const link of links) {
    if (link.url.startsWith('#')) continue;
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    deduped.push(link);
  }
  return { url, links: deduped };
}

export async function fetchUrl(page, rawUrl, opts, config, signal) {
  const url = normalizeUrl(rawUrl);
  const timeout = opts.timeout && opts.timeout > 0 ? opts.timeout : config.jobTimeoutMs || 30000;

  const abortIfNeeded = () => {
    if (signal?.aborted) {
      throw Object.assign(new Error('job aborted'), { code: 'TIMEOUT' });
    }
  };
  abortIfNeeded();

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    abortIfNeeded();
    throw Object.assign(new Error(`navigation failed: ${error.message}`), { code: 'NAV_FAILED' });
  }

  await handleCloudflare(page, { timeoutMs: Math.min(8000, timeout), logger: opts.logger });
  abortIfNeeded();

  if (opts.links) {
    return extractLinks(page, page.url());
  }

  await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
  const finalUrl = page.url();
  const html = await page.content();

  const { document } = parseHTML(html);
  // separateMarkdown keeps both: content = cleaned HTML, contentMarkdown = Markdown.
  const parsed = await Defuddle(document, finalUrl, { separateMarkdown: true });

  const markdown = parsed.contentMarkdown || parsed.content || '';
  const cleanedHtml = parsed.content || html;

  return {
    url: finalUrl,
    status: typeof response?.status === 'function' ? response.status() : undefined,
    title: parsed.title || '',
    author: parsed.author || '',
    published: parsed.published || '',
    site: parsed.site || '',
    description: parsed.description || '',
    words: parsed.wordCount || 0,
    markdown,
    html: cleanedHtml,
  };
}
