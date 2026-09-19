// Google /goto?url=<opaque> decoder, adapted from
// https://github.com/Xyborg/Google-Goto-URL-Extractor (MIT, by Martin Aberastegue).
//
// It maps opaque /goto keys to destination URLs that Google has already loaded
// into the page (window.W_jd, inline scripts, HTML comments and DOM attributes),
// without requesting or following the /goto endpoint. The function below is
// self-contained so it can be passed straight to page.evaluate.
export function collectGotoMap() {
  const BASE_URL = /^https?:$/i.test(location.protocol) ? location.origin : 'https://www.google.com';
  const mappings = new Map();
  const tokenOrder = new Map();
  let nextOrder = 0;

  function cleanEscapes(value) {
    return String(value ?? '')
      .trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/');
  }

  function decodeRepeatedly(value, rounds = 3) {
    let current = cleanEscapes(value);
    for (let i = 0; i < rounds; i += 1) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
    return current;
  }

  function normalizeGoto(value, depth = 0) {
    if (!value || depth > 4) return '';
    let candidate = decodeRepeatedly(value);
    try {
      const parsed = new URL(candidate, BASE_URL);
      if (parsed.pathname === '/url') {
        const nested = parsed.searchParams.get('url') || parsed.searchParams.get('q');
        return nested ? normalizeGoto(nested, depth + 1) : '';
      }
      if (parsed.pathname === '/goto') {
        const token = parsed.searchParams.get('url');
        return token ? `/goto?url=${token}` : '';
      }
    } catch {
      /* string fallbacks below */
    }
    const gotoIndex = candidate.indexOf('/goto?');
    if (gotoIndex >= 0) {
      candidate = candidate.slice(gotoIndex);
      try {
        const parsed = new URL(candidate, BASE_URL);
        const token = parsed.searchParams.get('url');
        return token ? `/goto?url=${token}` : '';
      } catch {
        return '';
      }
    }
    return '';
  }

  function extractGotos(value) {
    if (typeof value !== 'string') return [];
    const results = new Set();
    const variants = new Set([cleanEscapes(value), decodeRepeatedly(value)]);
    for (const variant of variants) {
      const direct = /[\s"'<>]/.test(variant) ? '' : normalizeGoto(variant);
      if (direct) results.add(direct);
      const matches = variant.match(/\/goto\?[^\s"'<>\\]*/gi) || [];
      for (const match of matches) {
        const normalized = normalizeGoto(match);
        if (normalized) results.add(normalized);
      }
    }
    return [...results];
  }

  function tokenFrom(value) {
    const normalized = normalizeGoto(value);
    if (!normalized) return '';
    try {
      return new URL(normalized, BASE_URL).searchParams.get('url') || '';
    } catch {
      return '';
    }
  }

  function rememberToken(value) {
    const token = tokenFrom(value);
    if (!token) return '';
    if (!tokenOrder.has(token)) tokenOrder.set(token, nextOrder++);
    return token;
  }

  function isGoogleTrackingHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return (
      /(^|\.)google\.[a-z.]+$/i.test(host) ||
      /(^|\.)googleadservices\.com$/i.test(host) ||
      /(^|\.)googlesyndication\.com$/i.test(host) ||
      /(^|\.)google-analytics\.com$/i.test(host) ||
      /(^|\.)googletagmanager\.com$/i.test(host) ||
      /(^|\.)doubleclick\.net$/i.test(host) ||
      /(^|\.)gstatic\.com$/i.test(host) ||
      /(^|\.)googleapis\.com$/i.test(host) ||
      /(^|\.)googleusercontent\.com$/i.test(host)
    );
  }

  function decodeTraditionalGoogleUrl(value) {
    try {
      const parsed = new URL(cleanEscapes(value), BASE_URL);
      if (parsed.pathname !== '/url') return value;
      const target = parsed.searchParams.get('url') || parsed.searchParams.get('q');
      if (!target || normalizeGoto(target)) return value;
      const targetUrl = new URL(target, BASE_URL);
      if (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') return targetUrl.href;
    } catch {
      /* keep original */
    }
    return value;
  }

  // A URL written inside prose keeps the punctuation that followed it
  // ("(see https://example.com/x)" yields ".../x)"), which parses as a valid
  // but wrong destination.
  function trimTrailingPunctuation(value) {
    let out = value;
    while (out) {
      const last = out[out.length - 1];
      const unbalanced = (out.match(/\)/g) || []).length > (out.match(/\(/g) || []).length;
      if ((last === ')' && unbalanced) || '.,;:!?'.includes(last)) {
        out = out.slice(0, -1);
        continue;
      }
      break;
    }
    return out;
  }

  function normalizeFinalUrl(value) {
    if (typeof value !== 'string') return '';
    let candidate = trimTrailingPunctuation(cleanEscapes(value).replace(/^['"]|['"]$/g, '').trim());
    if (/,\s*https?:\/\//i.test(candidate)) return '';
    candidate = decodeTraditionalGoogleUrl(candidate);
    try {
      const parsed = new URL(candidate, BASE_URL);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      if (isGoogleTrackingHost(parsed.hostname)) return '';
      if (
        parsed.hostname === 'www.w3.org' &&
        /^\/(?:1999\/xlink|2000\/svg|2000\/xml|2001\/XMLSchema)(?:\/|$)/.test(parsed.pathname)
      ) {
        return '';
      }
      if (/^(?:www\.)?(?:schema\.org|xmlns\.com|purl\.org|ogp\.me)$/i.test(parsed.hostname)) return '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function isImageUrl(value) {
    try {
      const parsed = new URL(value);
      return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i.test(parsed.pathname + parsed.search);
    } catch {
      return false;
    }
  }

  function urlDepthScore(value) {
    try {
      const parsed = new URL(value);
      let score = parsed.pathname === '/' ? 0 : parsed.pathname.split('/').filter(Boolean).length * 3;
      score += [...parsed.searchParams.keys()].length;
      if (isImageUrl(value)) score -= 20;
      return score;
    } catch {
      return -100;
    }
  }

  function isBetterCandidate(next, current) {
    if (!current) return true;
    if (next.score !== current.score) return next.score > current.score;
    return urlDepthScore(next.url) > urlDepthScore(current.url);
  }

  function addMapping(gotoValue, finalValue, score, source) {
    const goto = normalizeGoto(gotoValue);
    const token = rememberToken(goto);
    const url = normalizeFinalUrl(finalValue);
    if (!token || !url) return false;
    const candidate = { token, goto, url, score, source };
    const existing = mappings.get(token);
    if (isBetterCandidate(candidate, existing)) {
      mappings.set(token, candidate);
      return true;
    }
    return false;
  }

  function extractUrlsFromAboutReq(value) {
    if (typeof value !== 'string' || !/req(?:=|%3d)/i.test(value)) return [];
    const results = new Set();
    const cleaned = decodeRepeatedly(value, 2);
    const blobs = [];
    const reqPattern = /(?:[?&]|\b)req=([^&#\s"'<>]+)/gi;
    let match;
    while ((match = reqPattern.exec(cleaned))) blobs.push(match[1]);
    for (const blob of blobs) {
      try {
        let base64 = decodeRepeatedly(blob, 2).replace(/-/g, '+').replace(/_/g, '/');
        base64 += '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(base64);
        const urlPattern = /https?:\/\/[^\x00-\x20\x7f-\x9f"'<>\\]+/g;
        let urlMatch;
        while ((urlMatch = urlPattern.exec(binary))) {
          const url = normalizeFinalUrl(urlMatch[0]);
          if (url) results.add(url);
        }
      } catch {
        /* stale or non-base64 req blob */
      }
    }
    return [...results];
  }

  function extractFinalUrls(value) {
    if (typeof value !== 'string') return [];
    const results = new Set(extractUrlsFromAboutReq(value));
    const variants = new Set([cleanEscapes(value), decodeRepeatedly(value)]);
    for (const variant of variants) {
      const wholeValue = normalizeFinalUrl(variant);
      if (wholeValue) results.add(wholeValue);
      const urlPattern = /https?:\/\/(?:(?!,\s*https?:\/\/)[^\s"'<>\\\x00-\x1f])+/gi;
      let match;
      while ((match = urlPattern.exec(variant))) {
        const url = normalizeFinalUrl(match[0]);
        if (url) results.add(url);
      }
      const googleUrlPattern = /(?:https?:\/\/[^\s"'<>\\]+)?\/url\?[^\s"'<>\\]+/g;
      while ((match = googleUrlPattern.exec(variant))) {
        const url = normalizeFinalUrl(decodeTraditionalGoogleUrl(match[0]));
        if (url) results.add(url);
      }
    }
    return [...results];
  }

  function maybeParseJsonString(value) {
    if (typeof value !== 'string' || !value.includes('/goto')) return null;
    const cleaned = cleanEscapes(value).trim();
    if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) return null;
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  function createTreeMeta(parent, order, owner = null) {
    return { parent, depth: parent ? parent.depth + 1 : 0, order, owner };
  }

  function lowestCommonAncestor(left, right) {
    let a = left;
    let b = right;
    if (!a || !b) return null;
    while (a.depth > b.depth) a = a.parent;
    while (b.depth > a.depth) b = b.parent;
    while (a && b && a !== b) {
      a = a.parent;
      b = b.parent;
    }
    return a === b ? a : null;
  }

  function pairOccurrences(gotoOccurrences, urlOccurrences, source, baseScore, { requireSameOwner = false } = {}) {
    if (!gotoOccurrences.length || !urlOccurrences.length) return;
    const occurrencesByToken = new Map();
    for (const occurrence of gotoOccurrences) {
      const token = tokenFrom(occurrence.goto);
      if (!token) continue;
      if (!occurrencesByToken.has(token)) occurrencesByToken.set(token, []);
      occurrencesByToken.get(token).push(occurrence);
    }
    for (const occurrences of occurrencesByToken.values()) {
      let best = null;
      for (const gotoOccurrence of occurrences) {
        for (const urlOccurrence of urlOccurrences) {
          if (requireSameOwner && (!gotoOccurrence.meta.owner || gotoOccurrence.meta.owner !== urlOccurrence.meta.owner)) {
            continue;
          }
          const lca = lowestCommonAncestor(gotoOccurrence.meta, urlOccurrence.meta);
          if (!lca) continue;
          const candidate = {
            goto: gotoOccurrence.goto,
            url: urlOccurrence.url,
            lca,
            distance: gotoOccurrence.meta.depth + urlOccurrence.meta.depth - 2 * lca.depth,
            orderDistance: Math.abs(gotoOccurrence.order - urlOccurrence.order),
            image: isImageUrl(urlOccurrence.url),
            quality: urlOccurrence.quality || 0,
          };
          if (
            !best ||
            candidate.lca.depth > best.lca.depth ||
            (candidate.lca.depth === best.lca.depth && candidate.image !== best.image && !candidate.image) ||
            (candidate.lca.depth === best.lca.depth && candidate.image === best.image && candidate.distance < best.distance) ||
            (candidate.lca.depth === best.lca.depth &&
              candidate.image === best.image &&
              candidate.distance === best.distance &&
              candidate.orderDistance < best.orderDistance) ||
            (candidate.lca.depth === best.lca.depth &&
              candidate.image === best.image &&
              candidate.distance === best.distance &&
              candidate.orderDistance === best.orderDistance &&
              urlDepthScore(candidate.url) > urlDepthScore(best.url))
          ) {
            best = candidate;
          }
        }
      }
      if (!best) continue;
      // A depth-0 match means the token and the URL merely share the whole
      // scanned blob, which is no evidence of association: pairing there maps
      // every token in the blob to the same stray URL.
      if (best.lca.depth === 0) continue;
      addMapping(best.goto, best.url, baseScore + Math.min(best.lca.depth, 24) + (best.quality || 0), `${source}: smallest common subtree`);
    }
  }

  function collectStateOccurrences(root, maxNodes = Number.POSITIVE_INFINITY) {
    const gotos = [];
    const urls = [];
    const seen = new WeakSet();
    const rootMeta = createTreeMeta(null, 0);
    const stack = [{ value: root, meta: rootMeta }];
    let visited = 0;
    let order = 0;
    while (stack.length && visited < maxNodes) {
      const { value, meta } = stack.pop();
      visited += 1;
      if (typeof value === 'string') {
        const occurrenceOrder = order++;
        const extractedGotos = extractGotos(value);
        const extractedUrls = extractFinalUrls(value);
        const distinctTokens = new Set(extractedGotos.map(tokenFrom).filter(Boolean));
        for (const goto of extractedGotos) gotos.push({ goto, meta, order: occurrenceOrder });
        if (distinctTokens.size <= 1) {
          for (const url of extractedUrls) urls.push({ url, meta, order: occurrenceOrder });
        }
        const parsed = maybeParseJsonString(value);
        if (parsed) stack.push({ value: parsed, meta: createTreeMeta(meta, order++) });
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const values = Array.isArray(value) ? value : Object.values(value);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({ value: values[index], meta: createTreeMeta(meta, order++) });
      }
    }
    return { gotos, urls };
  }

  function scanStateTree(root, source = 'page state', maxNodes = Number.POSITIVE_INFINITY) {
    if (!root) return;
    const occurrences = collectStateOccurrences(root, maxNodes);
    for (const occurrence of occurrences.gotos) rememberToken(occurrence.goto);
    pairOccurrences(occurrences.gotos, occurrences.urls, source, 105);
  }

  function extractBalancedJsonObjects(text, markerRegex) {
    const results = [];
    markerRegex.lastIndex = 0;
    let marker;
    while ((marker = markerRegex.exec(text))) {
      let index = marker.index + marker[0].length;
      while (/\s/.test(text[index] || '')) index += 1;
      if (text[index] !== '{' && text[index] !== '[') continue;
      const start = index;
      const opening = text[index];
      const closing = opening === '{' ? '}' : ']';
      let depth = 0;
      let quote = '';
      let escaped = false;
      for (; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (char === opening) depth += 1;
        if (char === closing) depth -= 1;
        if (depth === 0) {
          const json = text.slice(start, index + 1);
          try {
            results.push(JSON.parse(json));
          } catch {
            /* not strict JSON */
          }
          markerRegex.lastIndex = index + 1;
          break;
        }
      }
    }
    return results;
  }

  function scanExistingDirectLinkMaps() {
    try {
      const exposedMap = window.__G_DIRECT_LINKS_MAP__;
      if (exposedMap instanceof Map) {
        for (const [goto, url] of exposedMap) addMapping(goto, url, 180, 'existing direct-links map');
      }
    } catch {}
    try {
      const dumped = window.__G_DIRECT_LINKS_DEBUG__?.dumpUrlMap?.();
      if (dumped && typeof dumped === 'object') {
        for (const [goto, url] of Object.entries(dumped)) addMapping(goto, url, 180, 'existing direct-links debug map');
      }
    } catch {}
  }

  function scanWindowState() {
    try {
      if (window.W_jd && typeof window.W_jd === 'object') scanStateTree(window.W_jd, 'window.W_jd');
    } catch {
      /* sealed */
    }
    try {
      if (window.__G_DIRECT_LINKS_WJD__ && typeof window.__G_DIRECT_LINKS_WJD__ === 'object') {
        scanStateTree(window.__G_DIRECT_LINKS_WJD__, 'captured W_jd');
      }
    } catch {}
  }

  function scanInlineScripts() {
    const markers = [/\b(?:var|let|const)\s+m\s*=\s*/g, /window(?:\[['"]W_jd['"]\]|\.W_jd)(?:\[['"][^'"]+['"]\])?\s*=\s*/g];
    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('/goto') && !text.includes('%2Fgoto') && !text.includes('\\u002fgoto')) continue;
      for (const marker of markers) {
        for (const parsed of extractBalancedJsonObjects(text, marker)) scanStateTree(parsed, 'inline script');
      }
    }
  }

  function scanCommentNodes() {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    let comment;
    while ((comment = walker.nextNode())) {
      const text = comment.nodeValue || '';
      if (!text.includes('/goto') && !text.includes('%2Fgoto') && !text.includes('\\u002fgoto')) continue;
      const separator = text.lastIndexOf('||');
      if (separator < 0) continue;
      const payload = text
        .slice(separator + 2)
        .trim()
        .replace(/\\\\&quot;/g, '\\"')
        .replace(/\\&quot;/g, '\\"')
        .replace(/&quot;/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&');
      if (!payload.startsWith('[') && !payload.startsWith('{')) continue;
      try {
        scanStateTree(JSON.parse(payload), 'HTML comment');
      } catch {
        /* malformed */
      }
    }
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collectDomOccurrences() {
    const gotos = [];
    const urls = [];
    const destinationAttributes = new Set([
      'href',
      'data-rw',
      'data-target-url',
      'data-fburl',
      'data-lpage',
      'data-pcu',
      'data-vurl',
      'data-video-url',
      'data-url',
    ]);
    const metaByElement = new WeakMap();
    const elements = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    elements.forEach((element, domIndex) => {
      const parentMeta = element.parentElement ? metaByElement.get(element.parentElement) : null;
      const meta = createTreeMeta(parentMeta || null, domIndex, element);
      metaByElement.set(element, meta);
      const values = element.getAttributeNames().map((name) => ({ name: name.toLowerCase(), value: element.getAttribute(name) || '' }));
      if (element instanceof HTMLAnchorElement && element.href) values.push({ name: 'href', value: element.href });
      for (const { name, value } of values) {
        for (const goto of extractGotos(value)) gotos.push({ goto, meta, order: domIndex, element });
        for (const url of extractFinalUrls(value)) {
          urls.push({
            url,
            meta,
            order: domIndex,
            element,
            quality: destinationAttributes.has(name) || /req(?:=|%3d)/i.test(value) ? 15 : -50,
          });
        }
      }
    });
    return { gotos, urls };
  }

  function youtubeWatchUrl(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (host === 'youtu.be') return parsed.pathname.length > 1 ? parsed : null;
      return /(^|\.)youtube\.com$/.test(host) && parsed.pathname === '/watch' ? parsed : null;
    } catch {
      return null;
    }
  }

  function timestampSeconds(value) {
    const match = String(value || '').match(/\b(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?!\d)/);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (match[1] && minutes > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function youtubeUrlAtTime(value, seconds) {
    const parsed = youtubeWatchUrl(value);
    if (!parsed || !Number.isInteger(seconds) || seconds < 0) return '';
    parsed.searchParams.set('t', `${seconds}s`);
    return parsed.href;
  }

  function compareStructuralCandidates(left, right) {
    return right.lca.depth - left.lca.depth || left.distance - right.distance || left.orderDistance - right.orderDistance;
  }

  function propagateYoutubeKeyMoments(gotoOccurrences) {
    const seeds = [];
    for (const occurrence of gotoOccurrences) {
      const token = tokenFrom(occurrence.goto);
      const mapping = mappings.get(token);
      if (!mapping || !youtubeWatchUrl(mapping.url)) continue;
      seeds.push({ ...occurrence, url: mapping.url });
    }
    if (!seeds.length) return;
    const unresolvedByToken = new Map();
    for (const occurrence of gotoOccurrences) {
      const token = tokenFrom(occurrence.goto);
      if (!token || mappings.has(token)) continue;
      const seconds = timestampSeconds(occurrence.element?.textContent);
      if (seconds === null) continue;
      if (!unresolvedByToken.has(token)) unresolvedByToken.set(token, []);
      unresolvedByToken.get(token).push({ ...occurrence, token, seconds });
    }
    for (const occurrences of unresolvedByToken.values()) {
      const bestByUrl = new Map();
      for (const occurrence of occurrences) {
        for (const seed of seeds) {
          const lca = lowestCommonAncestor(occurrence.meta, seed.meta);
          if (!lca) continue;
          const candidate = {
            goto: occurrence.goto,
            url: seed.url,
            seconds: occurrence.seconds,
            lca,
            distance: occurrence.meta.depth + seed.meta.depth - 2 * lca.depth,
            orderDistance: Math.abs(occurrence.order - seed.order),
          };
          const current = bestByUrl.get(seed.url);
          if (!current || compareStructuralCandidates(candidate, current) < 0) bestByUrl.set(seed.url, candidate);
        }
      }
      const candidates = [...bestByUrl.values()].sort(compareStructuralCandidates);
      const best = candidates[0];
      const runnerUp = candidates[1];
      if (!best || best.distance > 16 || best.lca.depth < 2) continue;
      if (runnerUp && best.lca.depth === runnerUp.lca.depth && runnerUp.distance - best.distance < 4) continue;
      const url = youtubeUrlAtTime(best.url, best.seconds);
      if (url) addMapping(best.goto, url, 150 + Math.min(best.lca.depth, 24), 'DOM: YouTube key moment');
    }
  }

  function orderTokensVisually(gotoOccurrences) {
    for (const occurrence of gotoOccurrences) rememberToken(occurrence.goto);
  }

  function scanDom() {
    const occurrences = collectDomOccurrences();
    orderTokensVisually(occurrences.gotos);
    pairOccurrences(occurrences.gotos, occurrences.urls, 'DOM attributes', 120, { requireSameOwner: true });
    propagateYoutubeKeyMoments(occurrences.gotos);
  }

  function scanAll() {
    mappings.clear();
    tokenOrder.clear();
    nextOrder = 0;
    scanDom();
    scanExistingDirectLinkMaps();
    scanWindowState();
    scanInlineScripts();
    scanCommentNodes();
    scanDom();
    const out = {};
    for (const [token, mapping] of mappings) {
      if (mapping.url) out[token] = mapping.url;
    }
    return out;
  }

  return scanAll();
}
