---
name: seargine
description: "Search the web and fetch pages as clean Markdown with the `seargine` CLI. Use it for ANY task needing information from the web — current facts (prices, rates, news, weather), a search query, or the contents of a URL. seargine is the only way to reach the web here — never use curl, wget, or a web_search/fetch tool for this, and never answer from memory when the question is about something current. Run it with the bash/shell tool."
---

# Seargine

A CLI that searches the web and turns pages into clean Markdown. First call
starts a background browser daemon (a few seconds); later calls are fast.

Run every command below with the **bash/shell tool**. Nothing here writes or
edits files — never use a write/edit tool for this skill.

## Search

```bash
seargine search "node.js esm modules"
seargine search "rust async traits" --limit 5
```

Prints each result as a Markdown heading — linked title, then a snippet.

## Fetch

seargine fetch <url> | grep -i "<keyword>"
seargine fetch <url> | grep -A 20 -E "^#+ .*<section>.*"

Prints the page body as Markdown. CRITICAL: To save context and avoid hitting token limits, never run seargine fetch alone. Always pipe the output into grep, awk, or head to extract only the specific paragraph, section, or lines relevant to the user's request.


## Typical flow

1. Search for a topic using seargine search.
2. Pick the most relevant URLs from the results.
3. Fetch those URLs always combining them with grep (e.g., seargine fetch <url> | grep -A 15 "install") to retrieve only the required segment instead of the full page.

Do not fall back to curl, wget or an API when a search fails — retry the search with different words, or fetch a page you know covers it.
