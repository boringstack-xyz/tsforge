# Research search: SearXNG, result routing, Hacker News, Stack Exchange

Status: agreed in chat 2026-09-27 ("agreed with all of it … do all this in a single PR").
Builds on: `2026-09-26-site-plugins-reddit-design.md`.

## Goal

A research run keeps bouncing between search and sources: it finds something
on Reddit, searches the web for more, lands on a Hacker News or Stack Exchange
thread, and goes back. Make every hop cheap:

- **Search** returns Google-quality results as JSON from the user's own
  SearXNG (already hosted in the home k3s, exposed LAN-only at `searx.lan` by
  argocd-app-of-apps#133), several queries per call, with already-read results
  flagged.
- **Every result says which reader to use.** Reddit → `reddit_thread`, Hacker
  News → `hn_thread`, Stack Exchange → `se_question`, anything else →
  `web_fetch`. `web_fetch` given a Reddit / HN / SE URL hands it to the plugin.
- **Hacker News and Stack Exchange plugins**, over their official public JSON
  APIs. They need no browser, so they are "direct" plugins.
- **Every source read** (threads, questions, web pages) is logged in
  `notes/<topic>/sources.md`, so nothing is read twice across restarts.

Nothing is tied to a particular topic or product.

## Why not Google through the browser

Google has no structured view, detects automated querying quickly ("unusual
traffic" CAPTCHAs, which tsforge cannot and must not solve), would put the
user's own Google account at risk, and its terms forbid it. SearXNG already
queries Google (the home instance uses Google CSE) and returns JSON.

## Plugin transport

`ISitePlugin` gains `transport: "browser" | "direct"`.

- `browser` (Reddit): as before — tools advertised only with the Chrome
  bridge; requests go through `page.fetch` in the user's tab.
- `direct` (HN, SE): tools advertised whenever the session can research (web
  tools on, or the browser capability on). Requests are made by tsforge itself
  with `directFetchJson(plugin, host, path)`: https only, host must be one the
  plugin declares, per-host pacing (1 req/s) with the same 429/5xx backoff as
  `page.fetch`, 20 s timeout, a tsforge user agent.
- `ISitePluginContext.session` becomes optional; a `stateKey` object (the
  browser session when there is one, else a stable per-workspace object) keys
  per-session plugin state (chunk caches, read sets).

`routeUrl(url)` on the registry returns `{ tool, args, key }` for URLs a plugin
owns, or null. `key` is the `sources.md` key (`reddit:abc12`, `hn:4214`,
`se:stackoverflow_123`).

## Hacker News plugin (`site-plugins/hackernews/`)

Host: `hn.algolia.com` (Algolia's official HN API; public, no key).

| Tool | Arguments | Behaviour |
|---|---|---|
| `hn_search` | `query`, `sort` relevance\|date, `type` story\|comment (default story), `time` day\|week\|month\|year\|all, `limit` ≤ 50, `page?`, `topic?` | `/api/v1/search` or `/search_by_date`, `numericFilters=created_at_i>…` for time. One line per hit: id, points, comments, age, title, domain; `already read` when logged. |
| `hn_thread` | `item` (id or `news.ycombinator.com/item?id=` URL), `topic`, `chunk?`, `force?` | `/api/v1/items/<id>` returns the WHOLE comment tree in one request. Rendered like Reddit threads (nested, author + age per comment), HTML → markdown, dead/deleted leaves dropped. Chunked + cached; logs `hn:<id>`; refuses already-read unless `force`. |

## Stack Exchange plugin (`site-plugins/stackexchange/`)

Host: `api.stackexchange.com` (official API v2.3; no key needed for 300
requests/day per IP; `TSFORGE_STACKEXCHANGE_KEY` raises it to 10,000).

| Tool | Arguments | Behaviour |
|---|---|---|
| `se_search` | `query`, `site` (default `stackoverflow`; any SE site: `electronics`, `music`, `diy`, `superuser`, `askubuntu`, …), `sort` relevance\|votes\|activity\|creation, `accepted?`, `limit` ≤ 50, `page?`, `topic?` | `/2.3/search/advanced`. One line per question: site/id, score, answers, ✓ accepted, age, title, tags; `already read` when logged. |
| `se_question` | `question` (id or any SE question URL), `site?` (inferred from the URL), `topic`, `chunk?`, `force?` | `/2.3/questions/{id}?filter=withbody` + `/2.3/questions/{id}/answers?sort=votes&filter=withbody` (2 requests). Question, then answers by votes with the accepted one marked; bodies HTML → markdown (code blocks kept). Logs `se:<site>_<id>`. |

The API's `backoff` field is honoured (the pacer waits that long), and
`quota_remaining` is shown in the footer when low.

## `web_search`

- `queries: string[]` (≤ 5) alongside `query`; results merged round-robin and
  deduplicated by URL.
- `recency` gains `week`.
- `topic?`: results whose source key is in `notes/<topic>/sources.md` are
  marked `already read`.
- Each result line ends with its reader: `→ reddit_thread post:"abc12"`,
  `→ hn_thread item:4214`, `→ se_question stackoverflow/123`, or `→ web_fetch`.
- Backend unchanged: SearXNG when `TSFORGE_SEARXNG_URL` is set (e.g.
  `http://searx.lan`), else DuckDuckGo.

## `web_fetch`

- A URL a plugin owns: with `topic`, the plugin's reader is called directly
  (same output as calling it); without `topic`, a one-line pointer to the
  right tool (no fetch).
- `topic?` for ordinary pages: the page is logged as `web:<12-hex sha1 of the
  normalised URL>` and a re-read is refused unless `force: true`.

## Guidance

A short "sources" playbook is appended (once) whenever research tools are on:
search with `web_search` (several phrasings, `topic`), follow each result's
reader hint, prefer `hn_*` / `se_*` / `reddit_*` over generic fetching, log
findings with `note` / `append`. The Reddit playbook stays as is.

## Testing

Fixtures shaped from the documented APIs (Algolia `hits` / `items` tree; SE
`items` with `quota_remaining` / `backoff`; SearXNG JSON). Unit tests for
routing, URL parsing (HN item URLs, every SE host shape), rendering, direct
fetch (host allowlist, https-only, pacing/backoff, SE `backoff`), multi-query
merge/dedupe, already-read flags, web_fetch delegation and page logging.
Break-to-prove on the host allowlist, dedupe, routing and refusal rules.
A live smoke test against the home SearXNG, HN and SE APIs from this machine.

## Out of scope

Stack Exchange comments (extra quota per question), HN user pages, Discourse
forums (next plugin), paid search APIs.
