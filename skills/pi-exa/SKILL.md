---
name: pi-exa
description: >-
  Exa web-research skill. Use this whenever the user needs information from
  the open web — current events, recent news, tech blog posts, papers,
  company info, product pages, or anything time-sensitive or post-cutoff.
  Also use when the user gives a URL and asks what's on it, what it says,
  or wants a summary. Even if the user just says "look that up" or "search
  the web", use this skill. CRITICAL: also use this for any factual claim
  about a named person's current role (CEO, founder, etc.), a product's
  current version number, current prices, current company status, or any
  "who is / what is / what version" question — these change over time
  and your training data is stale. A 2-second exa_answer is cheaper than
  giving a confidently wrong answer. This package exposes five first-class
  tools (exa_search, exa_similar, exa_fetch, exa_answer, exa_research)
  that are already visible in the system prompt; call them directly. Do
  NOT use for code/library API documentation (Context7 is better) or for
  repos and gists where the gh CLI works fine.
---

# pi-exa — Exa web research

## Prerequisite

Run this to check the API key:

```bash
scripts/exa.mjs status
```

If the key is missing, ask the user to run `/exa-auth <their-key>`
(gets one at <https://dashboard.exa.ai>). The CLI re-reads the key file
on every call, so no `/reload` is needed after auth changes.

## Five commands

| Intent | Tool (preferred) | Bash fallback |
|---|---|---|
| Discover URLs and read snippets | `exa_search` | `scripts/exa.mjs search` |
| Find pages similar to a URL | `exa_similar` | `scripts/exa.mjs similar` |
| Read or summarize known URLs | `exa_fetch` | `scripts/exa.mjs fetch` |
| Short factual question | `exa_answer` | `scripts/exa.mjs answer` |
| Deep multi-step research | `exa_research` | `scripts/exa.mjs research` |

Pick the leanest one. Searching when you only need a fetch wastes tokens;
fetching after a search whose highlights already answered the question is
redundant.

## search

```bash
scripts/exa.mjs search "<query>" [options]
```

**Why this command:** Discovery is the most common web-research task. Use
it when you don't yet have URLs and need to find them. The default output
is compact markdown with titles, URLs, and 2-3 highlights per result —
enough to judge relevance without drowning in text.

**Key options:**
- `--num N` — results (default 5, max 25). Keep small unless the user
  explicitly asked for breadth; each result is 150–400 tokens.
- `--days N` — restrict to last N days. Use for "recent / latest / current"
  intents; this computes the start date automatically.
- `--from YYYY-MM-DD` / `--to YYYY-MM-DD` — explicit date range.
- `--domain D` — include a domain (repeatable). Use for "find on arxiv"
  or "only from nature.com" intents.
- `--exclude D` — exclude a domain (repeatable).
- `--category C` — news, research paper, company, pdf, personal site,
  tweet, github.
- `--type T` — search algorithm. `auto` (default) is right for almost
  everything. Use `deep-reasoning` only when the query needs synthesis
  across many sources; it costs more and takes longer.
- `--full` — return ~5000 chars of page text per result instead of
  highlights. Use sparingly: it is expensive in tokens. Prefer the default
  highlights and `fetch` the one or two URLs you actually need.
- `--system-prompt S` — guides the LLM (deep types only).
- `--output-schema J` — JSON schema for structured deep-search output.

**Example:**
```bash
scripts/exa.mjs search "GPU memory bandwidth LLM inference" --type deep-reasoning --num 8
```

## similar

```bash
scripts/exa.mjs similar <url> [options]
```

**Why this command:** You found one great article and want more like it.
Exa finds semantically similar pages, not just same-domain links. Use
`--exclude-source` to avoid getting pages from the original site.

**Key options:**
- `--num N` — similar results (default 5, max 25)
- `--exclude-source` — omit the source URL's domain
- `--full` — full text instead of highlights

**Example:**
```bash
scripts/exa.mjs similar https://exa.ai/blog/introducing-exa --exclude-source --num 5
```

## fetch

```bash
scripts/exa.mjs fetch <url> [<url> ...] [options]
```

**Why this command:** You already have URLs (from a previous search,
from the user, or from your own knowledge). Fetch reads them directly.
Pass multiple URLs in one call — Exa fetches in parallel and separates
blocks with `---`.

**Key options:**
- `--mode text` (default) | `summary` | `highlights`
- `--max-chars N` — char budget per page (default 5000 for text)
- `--livecrawl always` — bypass Exa's cache and fetch fresh content.
  Use for pages that change often: stock prices, status pages, live news.
- `--subpages N` — extract N internal subpages per URL (about, team,
  blog, etc.). The subpages are derived from internal links.
- `--subpage-target T` — fuzzy text to match subpages. Pass "about"
  to prioritize about pages, "team" for team pages.

**Examples:**
```bash
# Read a page in depth
scripts/exa.mjs fetch https://exa.ai/docs/sdks/javascript-sdk --mode text

# Get fresh content from a status page
scripts/exa.mjs fetch https://status.openai.com --livecrawl always

# Extract about and team pages from a company site
scripts/exa.mjs fetch https://anthropic.com --subpages 5 --subpage-target about
```

## answer

```bash
scripts/exa.mjs answer "<question>" [options]
```

**Why this command:** The user asked a short factual question and you
don't need to read the sources yourself. Exa synthesizes an answer with
citations. For anything needing comparison, analysis, or direct quotation,
prefer `search` so you can read the actual pages.

**Key options:**
- `--location CC` — ISO country code for location-aware answers (US, JP)
- `--system-prompt S` — guide the answer style. For example:
  "Answer concisely in Chinese" or "Be skeptical and fact-check claims"

**Example:**
```bash
scripts/exa.mjs answer "Who is the current CEO of Anthropic?" --system-prompt "Answer in one sentence"
```

## research

```bash
scripts/exa.mjs research "<instructions>" [options]
```

**Why this command:** The topic needs thorough investigation across
multiple sources, not a quick lookup. Exa's research agent plans, searches,
crawls, and synthesizes a comprehensive answer. This takes 1–5 minutes;
warn the user if the topic is complex.

**Key options:**
- `--model MODEL` — `exa-research-fast` (quick, cheap), `exa-research`
  (default, balanced), `exa-research-pro` (thorough, strongest reasoning)
- `--max-wait MS` — timeout (default 300000 = 5 minutes)
- `--output-schema J` — JSON schema for structured output

**Example:**
```bash
scripts/exa.mjs research "Compare Claude, GPT-4, and Gemini for code generation in 2025. Include pricing and key differentiators." --model exa-research-pro
```

## Decision quickstart

- "What's the latest about X?" → `exa_search` with `--days 30`
- "Find recent papers on X" → `exa_search` with `--category "research paper" --days 90`
- "Find more like this URL" → `exa_similar`
- "What does this URL say?" → `exa_fetch --mode text`
- "Summarize this URL" → `exa_fetch --mode summary`
- "Get real-time status" → `exa_fetch --livecrawl always`
- "Extract subpages" → `exa_fetch --subpages 5`
- "Who is the current Y?" → `exa_answer`
- "Write a research report on X" → `exa_research`
- "Compare approaches to X" → `exa_research`
- "Find arxiv papers" → `exa_search --domain arxiv.org`

## Errors

The CLI exits non-zero with an `EXA_*` prefix on stderr:

| Code | What it means | What to do |
|---|---|---|
| `EXA_KEY_MISSING` | No API key configured | Ask the user to run `/exa-auth <key>`. Don't retry. |
| `EXA_AUTH` | Key invalid or revoked | Same fix as above. |
| `EXA_RATE_LIMIT` | Hit Exa rate limit | Back off; retry once after a pause, otherwise stop. |
| `EXA_HTTP_<code>` | Exa API error | Surface the message; investigate before retrying. |
| `EXA_NETWORK` | Transient network issue | One retry is fine; otherwise stop. |
| `EXA_SDK_MISSING` | Package not installed cleanly | Tell the user to run `pi update https://github.com/capyup/pi-exa.git`. |

## Advanced usage

For streaming, Zod schemas, Search Monitors, Websets, or other less
common patterns, read [references/advanced.md](references/advanced.md).
Only load that file when you actually need one of those things — it keeps
the common path in this file lean.
