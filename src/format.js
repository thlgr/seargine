function yamlScalar(value) {
  const text = String(value);
  if (text === '') return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 _.,:/@+-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

export function frontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function truncate(text, maxChars) {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function formatFetchMarkdown(docs, { includeFrontmatter = true, maxChars = null } = {}) {
  const blocks = docs.map((doc) => {
    let body = truncate((doc.markdown || '').trim(), maxChars);
    let out = '';
    if (includeFrontmatter) {
      out += `${frontmatter({
        title: doc.title,
        url: doc.url,
        author: doc.author,
        published: doc.published,
        words: doc.words,
      })}\n\n`;
    }
    if (doc.title && !/^\s*#\s/.test(body)) {
      out += `# ${doc.title}\n\n`;
    }
    out += body;
    return out.trim();
  });
  return blocks.filter(Boolean).join('\n\n---\n\n');
}

export function formatLinksMarkdown(links) {
  return links
    .map((link) => (link.text ? `- [${link.text}](${link.url})` : `- ${link.url}`))
    .join('\n');
}

export function formatSearchMarkdown(results, { query = '' } = {}) {
  const blocks = results.map((result) => {
    const title = (result.title || result.url).replace(/[[\]]/g, '\\$&');
    const snippet = (result.snippet || '').replace(/\s+/g, ' ').trim();
    const lines = [`## [${title}](${result.url})`];
    if (snippet) lines.push('', snippet);
    return lines.join('\n');
  });
  const count = `${results.length} result${results.length === 1 ? '' : 's'}`;
  const header = query ? `Results for "${query}" (${count})` : `Results (${count})`;
  return [header, ...blocks].join('\n\n');
}
