---
name: web-search
description: "Web search and URL content extraction via the Tavily CLI (tvly). SEARCH current information when no URL is known: 'search for', 'find articles about', 'what's the latest on'. EXTRACT clean markdown/text from specific URLs: 'extract', 'grab the content from', 'pull the text from', 'get the page at', 'read this webpage' — handles JavaScript-rendered pages, up to 20 URLs per call. Workflow: search → extract; --include-raw-content on a search can skip the extract step. NOT deep multi-source research reports (→ research)."
disable-model-invocation: false
---

# web-search (tvly)

Two verbs, one CLI: **search** = no URL yet, **extract** = have URL.

| Need | Command |
|------|---------|
| Current info, no URL | `tvly search "query" --json` |
| Known URL content | `tvly extract "https://…" --json` |

## Before running

`tvly` not on PATH → ask before install (unpinned `curl | bash`):

```bash
curl -fsSL https://cli.tavily.com/install.sh | bash && tvly login
```

On approval: install + `tvly login`. Declined/failed → stop, report; no retry loops.

## Search

```bash
# Basic
tvly search "your query" --json

# Advanced, more results
tvly search "quantum computing" --depth advanced --max-results 10 --json

# Recent news
tvly search "AI news" --time-range week --topic news --json

# Domain-filtered
tvly search "SEC filings" --include-domains sec.gov,reuters.com --json

# Full page content (may save extract call)
tvly search "react hooks tutorial" --include-raw-content --max-results 3 --json
```

| Option | Description |
|--------|-------------|
| `--depth` | `ultra-fast`, `fast`, `basic` (default), `advanced` |
| `--max-results` | Max results 0-20 (default 5) |
| `--topic` | `general` (default), `news`, `finance` |
| `--time-range` | `day`, `week`, `month`, `year` |
| `--start-date` / `--end-date` | Date bounds (YYYY-MM-DD) |
| `--include-domains` / `--exclude-domains` | Domain filter, comma-separated |
| `--country` | Boost country results |
| `--include-answer` | AI answer (`basic`/`advanced`) |
| `--include-raw-content` | Full page content (`markdown`/`text`) |
| `--include-images` / `--include-image-descriptions` | Image results |
| `--chunks-per-source` | Chunks per source (advanced/fast depth only) |
| `-o, --output` | Save to file |
| `--json` | Structured JSON |

Depth: `ultra-fast`/`fast` = latency matters; `basic` = general; `advanced` = precision/specific facts.

Tips:
- **Budget: `--max-results 3`, stop after 2-3 searches** — synthesize before searching more; extra searches add context tokens every remaining turn, rarely signal.
- Queries <400 chars — search query, not prompt.
- Complex queries → sub-queries.
- Need full page text → `--include-raw-content` (saves extract call).
- Stdin: `echo "query" | tvly search - --json`

## Extract

Clean markdown/text from URLs (≤20/call).

```bash
# Single URL
tvly extract "https://example.com/article" --json

# Multiple URLs
tvly extract "https://example.com/page1" "https://example.com/page2" --json

# Query-focused (relevant chunks only)
tvly extract "https://example.com/docs" --query "authentication API" --chunks-per-source 3 --json

# JS-heavy pages
tvly extract "https://app.example.com" --extract-depth advanced --json

# Save to file
tvly extract "https://example.com/article" -o article.md
```

| Option | Description |
|--------|-------------|
| `--query` | Rerank chunks by relevance |
| `--chunks-per-source` | Chunks per URL (1-5, requires `--query`) |
| `--extract-depth` | `basic` (default) / `advanced` (JS-rendered) |
| `--format` | `markdown` (default) / `text` |
| `--include-images` | Image URLs |
| `--timeout` | Max wait 1-60s |
| `-o, --output` | Save to file |
| `--json` | Structured JSON |

Tips:
- `basic` depth first; `advanced` fallback when content missing.
- `--query` + `--chunks-per-source` = relevant chunks only, not full pages.
- Batch >20 URLs into multiple calls.
- Search already returned content via `--include-raw-content` → skip extract.
