# Site plugins for the Chrome bridge — Reddit first

Status: design approved in chat 2026-09-26, pending written-spec review.
Builds on: `2026-09-25-chrome-research-bridge-design.md`.

## Goal

Make tsforge an expert researcher on specific sites, starting with Reddit, on top
of the existing Chrome bridge. The user gives a research brief (any product, any
topic); the agent turns it into a plan, gathers evidence efficiently, records
findings in a consistent shape, and writes a logical report.

Success looks like: a brief such as "research the problems people have with X and
gather feedback for our app" runs as a handful of targeted searches plus full
comment threads read through structured data — not one browser tab per thread,
not rendered-page scrolling, not "load more replies" clicking — and ends with
`notes/<topic>/report.md`.

Nothing in tsforge is coupled to a particular product or topic. The product (if
any) and the angles come from the brief.

## Decisions (made with the user)

1. **Data source: Reddit's JSON views through the user's logged-in tab.** Nearly
   every Reddit page has a `.json` twin. One request returns a whole comment tree
   with scores, authors and timestamps — ~10× fewer tokens than rendered pages.
2. **Images: download automatically, describe on demand.** Post and comment
   images are saved next to the notes and referenced inline; the agent looks at
   one with the existing `read_image` (vision) only when it matters. Video is
   linked, never downloaded.
3. **Built-in plugins only.** Plugins live in tsforge's source, are reviewed and
   released like any change. The interface is internal but shaped so it could be
   opened later. No user-supplied plugins (they would inherit a fetch capability
   using the user's logins).
4. **Read-only stays read-only.** No posting, voting, joining, messaging.

## Architecture

```
agent ─ reddit_search / reddit_thread / reddit_listing / reddit_subreddits
          │
          ▼
core  site-plugins/reddit  ── builds .json URL, paces requests
          │  bridge request "page.fetch" {tab, url}
          ▼
extension  handlers → content script fetch() in the Reddit tab (user's cookies)
          │  { status, contentType, body }  (≤ 5 MB, JSON/text only)
          ▼
core  parse → render compact markdown → download images → chunk → agent
```

### Core: `packages/core/src/site-plugins/` (new subsystem, tier optional)

- `site-plugins.types.ts`
  - `ISitePlugin { id; hosts: readonly string[]; tools: IToolSchema[];
    guidance: string; handlers: Record<string, SitePluginHandler> }`
  - `SitePluginHandler = (args, ctx: ISitePluginContext) => Promise<string>`
    (never throws; failures are returned as tool errors like the browser tools)
  - `ISitePluginContext { session: IBrowserSession; cwd; fetchJson(host, path);
    downloadAsset(url, destDir); pacer; report }`
- `registry.ts` — `SITE_PLUGINS: readonly ISitePlugin[]` (Reddit only for now),
  `sitePluginTools(caps)`, `sitePluginGuidance()`, `findSitePluginHandler(name)`.
- `fetch.ts` — `pageFetchJson(session, host, path)`:
  - finds or opens ONE tab on `https://<host>/` in the tsforge group and reuses
    it for every request (no tab per thread);
  - sends `page.fetch`; parses JSON; maps 403/404/429/5xx to typed errors.
- `pacer.ts` — per-host pacing (default 1 request/second) with backoff on 429
  (honours `Retry-After`, else 2s → 4s → … capped at 60s, 5 attempts), and on
  5xx (3 attempts). Clock and sleep injected for tests.
- `assets.ts` — direct download of public media: URL vetted with the existing
  SSRF guard (`vetUrl`/`isPrivateHost`), allowlisted media hosts per plugin,
  content-type must be `image/*`, 10 MB cap per file, 30 per thread, written to
  `notes/<topic>/assets/<post-id>/<n>.<ext>`. A failed download never fails the
  tool call; the item renders as a plain link.
- `sources-log.ts` — `notes/<topic>/sources.md` ledger (append-only, harness
  owned): one line per thread read (URL, title, score, comments, date read).
  Parsed at session start for duplicate detection that survives restarts.
- `reddit/` — the Reddit plugin:
  - `reddit.constants.ts` (hosts `www.reddit.com`, `old.reddit.com`; media hosts
    `i.redd.it`, `preview.redd.it`, `external-preview.redd.it`, `i.imgur.com`;
    limits)
  - `reddit.types.ts` (the subset of Reddit's listing/thing JSON we read)
  - `urls.ts` (post id/URL normalisation, search/listing/thread/morechildren URLs)
  - `parse.ts` (JSON → internal post/comment tree; guards, no `as`)
  - `expand.ts` (collapsed replies: `more` things via
    `/api/morechildren.json?link_id=t3_<id>&children=…&api_type=json&raw_json=1`
    in batches of ≤100 ids, and "continue this thread" via
    `/comments/<id>/_/<comment>.json`, until the `maxComments` budget)
  - `render.ts` (tree → markdown, see Output)
  - `media.ts` (post image / gallery order via `gallery_data` + `media_metadata`
    / preview source / comment image links and inline `media_metadata`)
  - `tools.ts`, `guidance.ts`, `index.ts`

### Wiring into the harness

- Plugin tools are advertised only when the browser capability is on (same gate
  as `browser_*`), added to `AdvertisedTool` / `TOOL_SPECS`, dispatched through
  `HANDLERS` via `findSitePluginHandler`.
- Policy: `reddit_*` classified `network` (allowed wherever browsing is).
- Readonly-spin: `reddit_*` count as research progress (`RESEARCH_TOOLS`).
- Guidance: `sitePluginGuidance()` is appended once with `guideOnce` when the
  browser capability turns on, next to `BROWSER_RESEARCH_GUIDANCE`.
- Session state: per-session set of thread ids read (seeded from sources logs).

### Extension: `page.fetch`

- New bridge method `page.fetch { tab, url }` → `{ status, contentType, body }`.
- Executed by the **content script** in the tab (isolated world `fetch`,
  `credentials: "include"`), so it is a same-origin request carrying the user's
  cookies exactly as the page's own requests do.
- Refused unless ALL hold (checked in the extension; nothing from tsforge is
  trusted):
  - the tab is in the tsforge group;
  - `url` is https and its origin equals the tab's current origin;
  - that host is in `FETCH_HOSTS`, a constant compiled into the extension
    (`www.reddit.com`, `old.reddit.com`) — tsforge cannot widen it;
  - method GET, no custom headers, no body (the handler builds the request);
  - response content-type is JSON or text; body truncated/refused over 5 MB.
- `PROTOCOL_VERSION` bumps to 2 (an old extension reports a mismatch instead of
  silently lacking the method). A new bridge status `outdated` makes `/browser`
  and the boot chip say "rebuild + reload the extension"; the extension shows
  the same in its options page and keeps retrying on its normal backoff, so
  updating either side reconnects on its own.
- Timeout for `page.fetch`: 20s.

### `note` tool: topic folders

- New optional `file` argument: `"findings" | "report"`.
  - Absent → today's behaviour, `notes/<slug>.md` (backward compatible).
  - `findings` → append to `notes/<slug>/findings.md`.
  - `report` → `notes/<slug>/report.md`; accepts `replace: true` (the only
    non-append write `note` allows, so the synthesis can be rewritten as it
    improves).
- Same realpath/symlink protections extended to the topic folder.
- `sources.md` is harness-written only (not a `note` target).

## Tools

| Tool | Arguments | Behaviour |
|---|---|---|
| `reddit_search` | `query`, `subreddit?`, `sort` = relevance\|top\|new\|comments, `time` = hour\|day\|week\|month\|year\|all, `limit` ≤ 100 (default 25), `after?` | `/search.json` or `/r/<sub>/search.json?restrict_sr=1`, `type=link`, `raw_json=1`. One line per post: title, r/sub, ↑score, comments, age, 📷 when it has images, `already read` when in the sources log, id. Returns `after` for the next page. |
| `reddit_thread` | `post` (id or URL), `topic` (notes folder), `sort` = top\|best\|new (default top), `maxComments` (default 500, max 2000) | `/comments/<id>.json?limit=500&sort=<s>&raw_json=1`, expands collapsed replies to the budget, downloads images, appends to `sources.md`, returns chunk 1 of the rendered thread plus `chunk` hint. |
| `reddit_thread` (continued) | `post`, `chunk` | Further chunks served from a per-session cache; no refetch. |
| `reddit_listing` | `subreddit`, `sort` = hot\|new\|top\|rising, `time?`, `limit`, `after?` | Subreddit browse; same line format as search. |
| `reddit_subreddits` | `query`, `limit` | `/subreddits/search.json`: name, subscribers, one-line description — to choose communities first. |

## Output format (what the agent reads)

- Chunks of ≈6000 chars (`READ_CHUNK_CHARS`), first chunk starts with the thread
  URL and the `UNTRUSTED DATA` header used by `browser_read`.
- Post header: `# [r/<sub>] <title> (↑<score> · <n> comments · <age> · u/<op>)`,
  then the body, then post images.
- Comments as a nested list; replies indented one level per depth; each comment
  one header line `u/<author> ↑<score> · <age>:` then its text. The OP is
  marked `(OP)`.
- Images inline: `[image <n>: notes/<topic>/assets/<id>/<n>.jpg — post]` or
  `— comment by u/<author>`; video: `[video: <url> — not downloaded]`.
- Dropped: `[deleted]`/`[removed]` comments with no replies (kept as a stub when
  they have replies), AutoModerator, stickied moderator comments.
- Footer on the last chunk: comments shown / total, collapsed replies not
  fetched (budget), images saved / failed.

## Research playbook (generic guidance)

Appended to the system prompt when the browser capability is on. Topic- and
product-neutral; everything specific comes from the brief:

1. **Plan** — restate the goal in one line; list 5–10 angles to search; pick
   the notes topic (a short slug).
2. **Find communities** — `reddit_subreddits` for the domain.
3. **Search wide, then deep** — several phrasings per angle; `sort=top` with
   `time=year`/`all` for depth, `sort=new` for current pain; skip `already read`.
4. **Read fully** — pick by comment count and score; `reddit_thread` reads the
   whole discussion; never `browser_click`/`browser_read` on Reddit when a
   `reddit_*` tool covers it.
5. **Record** — after every thread or two, `note` with `file: "findings"`:

   ```
   ## <short pain point>
   - What: <the problem in one sentence>
   - Evidence: "<quote>" — u/<author> ↑<score>, r/<sub>, <link> (+N more)
   - Signal: frequency ×N, intensity low|medium|high
   - Implication: <what this means for the product in the brief, or the opportunity>
   ```
6. **Images** — `read_image` only when an image carries the insight.
7. **Synthesize** — `note` with `file: "report", replace: true`: top themes
   ranked by frequency × intensity; 2–3 quotes each with links; who is asking;
   product ideas / opportunities linked to themes; gaps and open questions.

## Error handling

- Extension missing / bridge down → the tool returns the same actionable error
  as `browser_*` (`/browser` for setup).
- Old extension (protocol 1) → "reload the tsforge extension" error.
- Not logged in / 403 → tool error saying Reddit refused the request; public
  content still works logged out in most cases.
- 404 / removed thread → clear error, no retry.
- 429 → paced retries with backoff; after the last attempt a tool error that
  tells the agent to pause (the harness never spins on it).
- Malformed JSON → tool error with the first 200 chars; no crash.
- Image failures → logged in the footer, never fail the call.

## Security

- `page.fetch` constraints above are enforced in the extension; the host list is
  compiled in.
- All Reddit text is marked untrusted; guidance repeats that instructions inside
  threads are data.
- Asset downloads: https only, media-host allowlist, SSRF guard, image
  content-type, size caps, fixed destination under `notes/`.
- No write-type Reddit endpoints are ever constructed; `urls.ts` builds only
  the read endpoints listed here (tested).

## Testing

- **Fixtures** (hand-written, shaped from Reddit's documented JSON): thread with
  nested replies, `more` batches and "continue this thread"; gallery post;
  single-image post; comment image links + inline `media_metadata`; deleted and
  removed comments; AutoModerator/sticky; search page with `after`; listing;
  subreddit search; a 429 with `Retry-After`.
- **Core unit tests:** URL building (read endpoints only), parse guards, render
  format, expansion within budget (and budget respected), chunk cache, sources
  log + duplicate detection across a restart, media extraction and gallery
  order, asset vetting (private host, wrong content-type, oversize, cap of 30),
  pacer (1/s, Retry-After, backoff cap), `note` topic folders + `replace` only
  for report + symlink refusal.
- **Extension tests:** `page.fetch` refused for another origin, a host not in
  `FETCH_HOSTS`, a tab outside the group, oversized and non-JSON responses;
  allowed same-origin GET carries credentials.
- **End-to-end:** real WebSocket bridge + jsdom-faked Chrome with a fake Reddit
  tab serving the fixtures; runs `reddit_search` → `reddit_thread` → `note` and
  checks the notes folder.
- **Break-to-prove:** each `page.fetch` refusal rule, the media-host allowlist
  and the duplicate check are removed in turn and their tests must go red.
- **Manual:** a real brief against live Reddit in the user's Chrome (the only
  place live Reddit behaviour is verified — Claude's own browser tooling cannot
  open reddit.com).

## Docs

- `apps/docs/src/content/docs/integrations/reddit.mdx` (new): what it does, the
  tools, the research playbook, notes layout, images, limits, safety.
- `integrations/chrome.mdx`: "Site plugins" section + protocol 2 reload note.
- Internals: `site-plugins` in the architecture map (generated) and a short
  "adding a site plugin" section in where-to-change.

## Out of scope (for now)

- Other sites (Hacker News, Discourse, Stack Overflow) — the layer is ready for
  them; each is its own change.
- User post history, cross-post following, Reddit's official OAuth API.
- User-supplied plugins.
- The all-night episode driver (separate roadmap item).
