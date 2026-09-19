// Cloudflare / captcha detection only.
//
// We deliberately do NOT attempt to click or solve challenges. If a page is
// protected by a Cloudflare interstitial we wait briefly in case a managed
// challenge clears on its own, then return a clear, parseable error. Anything
// that needs a human (hCaptcha / reCAPTCHA) is reported as unsupported.
const DETECT_FN = () => {
  const has = (selector) => !!document.querySelector(selector);
  const title = document.title || '';
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 2000);
  return {
    title,
    titleSignal: /just a moment|attention required|checking your browser|verifying you are human|um momento|un momento|une moment|verifica(ndo|ção)/i.test(title),
    textSignal: /checking your browser|verifying you are human|executando verifica|verificação de segurança|just a moment/i.test(bodyText),
    challengeForm:
      has('#challenge-form') || has('[id^="cf-chl"]') || has('.cf-chl') || has('#cf-please-wait') || has('#cf-wrapper'),
    cfOpt: typeof window._cf_chl_opt !== 'undefined',
    turnstile:
      has('iframe[src*="challenges.cloudflare.com"]') ||
      has('script[src*="challenges.cloudflare.com"]') ||
      has('.cf-turnstile'),
    hcaptcha: has('iframe[src*="hcaptcha.com"]') || has('.h-captcha'),
    recaptcha: has('iframe[src*="google.com/recaptcha"]') || has('.g-recaptcha'),
    bodyText,
  };
};

async function detect(page) {
  try {
    return await page.evaluate(DETECT_FN);
  } catch {
    // A null result means the document was mid-navigation.
    return null;
  }
}

function isChallenge(info) {
  if (!info) return false;
  // A Turnstile script/iframe alone is common on normal Cloudflare-protected
  // pages, so only the interstitial markers count as a challenge.
  return info.titleSignal || info.textSignal || info.challengeForm;
}

function isHardCaptcha(info) {
  if (!info || info.turnstile) return false;
  return (info.hcaptcha || info.recaptcha) && (info.titleSignal || info.textSignal);
}

// Challenge scripts are injected asynchronously; poll briefly before deciding
// a page is clean.
async function waitForChallenge(page, timeoutMs) {
  let info = await detect(page);
  if (isChallenge(info) || isHardCaptcha(info)) return info;
  await new Promise((r) => setTimeout(r, 600));
  info = await detect(page);
  if (isChallenge(info) || isHardCaptcha(info)) return info;
  if ((info?.bodyText || '').length < 200) {
    const deadline = Date.now() + timeoutMs;
    while (!isChallenge(info) && !isHardCaptcha(info) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      info = await detect(page);
    }
  }
  return info;
}

export async function handleCloudflare(page, { timeoutMs = 8000, logger } = {}) {
  await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.min(2500, timeoutMs) }).catch(() => {});
  const info = await waitForChallenge(page, Math.min(3000, timeoutMs));
  if (!info) return { challenged: false };

  if (isHardCaptcha(info)) {
    const error = new Error(
      info.hcaptcha ? 'page is protected by hCaptcha (needs human)' : 'page is protected by reCAPTCHA (needs human)',
    );
    error.code = 'CAPTCHA_UNSUPPORTED';
    throw error;
  }
  if (!isChallenge(info)) return { challenged: false };

  logger?.debug?.(`cloudflare challenge detected (turnstile=${!!info.turnstile})`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await detect(page);
    if (!current) {
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    if (!isChallenge(current)) {
      await page.waitForNetworkIdle({ idleTime: 400, timeout: 3000 }).catch(() => {});
      return { challenged: true, cleared: true };
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  const error = new Error(`blocked by Cloudflare challenge after ${timeoutMs}ms`);
  error.code = 'CLOUDFLARE_BLOCKED';
  throw error;
}

export { detect as detectChallenge, isChallenge as isCloudflareChallenge };
