// Minimal robots.txt check used only when --respect-robots is passed.
// Handles the common cases: user-agent groups, Allow/Disallow prefix rules and
// the longest-match-wins convention. It is intentionally lightweight and not a
// full RFC 9309 implementation.
function parseRobots(text) {
  const groups = [];
  let current = null;
  let expectingAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !expectingAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgent = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      expectingAgent = false;
      current.rules.push({ allow: field === 'allow', path: value });
    } else {
      expectingAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  const escaped = rulePath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/g, '$');
  const pattern = new RegExp(`^${escaped}`);
  return pattern.test(path);
}

export async function isAllowedByRobots(url, { userAgent = 'seargine', timeoutMs = 5000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  let text;
  try {
    const res = await fetch(`${parsed.protocol}//${parsed.host}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': userAgent },
    });
    if (!res.ok) return true;
    text = await res.text();
  } catch {
    return true; // unreachable robots.txt => assume allowed
  }

  const groups = parseRobots(text);
  const ua = userAgent.toLowerCase();
  let best = null;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*' || ua.includes(agent)) {
        const specificity = agent === '*' ? 0 : agent.length;
        if (!best || specificity > best.specificity) {
          best = { specificity, rules: group.rules };
        }
      }
    }
  }
  if (!best) return true;

  const target = `${parsed.pathname}${parsed.search}`;
  let decision = true;
  let bestLength = -1;
  for (const rule of best.rules) {
    if (!rule.path) continue;
    if (ruleMatches(rule.path, target) && rule.path.length > bestLength) {
      bestLength = rule.path.length;
      decision = rule.allow;
    }
  }
  return decision;
}
