import { isRecord, isArray } from "../../lib/guards";
import { reject, str, type IToolContext } from "./tool-context";
import { validateFetchUrl } from "./web-fetch";
import { readSources, routeUrl, webKey } from "../../site-plugins";

/** DuckDuckGo's no-JS HTML endpoint — free, keyless, and returns plain markup we
 *  can parse. The default backend so web search works out of the box with zero
 *  setup. Users who want full privacy/control can point at a self-hosted SearXNG
 *  via TSFORGE_SEARXNG_URL instead. */
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

const DEFAULT_MAX_RESULTS = 8;
const MAX_ALLOWED_RESULTS = 20;
const MAX_DOMAINS = 5;
/** Queries per call — several phrasings in one turn, merged and deduplicated. */
const MAX_QUERIES = 5;

export type WebSearchRecency = "day" | "week" | "month" | "year";
type WebSearchBackend = "duckduckgo" | "searxng";

export interface ISearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ISearchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface IWebSearchDeps {
  fetchFn: (url: string) => Promise<ISearchResponse>;
}

function parseRecency(value: unknown): WebSearchRecency | null {
  if (
    value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "year"
  ) {
    return value;
  }

  return null;
}

/** `queries` (up to MAX_QUERIES) plus `query`, trimmed and deduplicated. */
function queriesArg(args: Record<string, unknown>): string[] {
  const list = isArray(args.queries) ? args.queries : [];
  const all = [
    str(args, "query"),
    ...list.filter((q): q is string => typeof q === "string"),
  ];

  return [
    ...new Set(all.map((q) => q.trim()).filter((q) => q.length > 0)),
  ].slice(0, MAX_QUERIES);
}

/** Round-robin merge so every phrasing contributes its best results first. */
export function mergeRoundRobin(
  lists: readonly (readonly ISearchResult[])[]
): ISearchResult[] {
  const out: ISearchResult[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      const item = list[i];

      if (item !== undefined) {
        out.push(item);
      }
    }
  }

  return out;
}

function recencyArg(args: Record<string, unknown>): WebSearchRecency | null {
  const value = args.recency;

  if (value === undefined || value === null || value === "") {
    return null;
  }

  return parseRecency(value);
}

function maxResults(args: Record<string, unknown>): number {
  const value = args.maxResults;

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_ALLOWED_RESULTS);
  }

  return DEFAULT_MAX_RESULTS;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo wraps result links in a `/l/?uddg=<encoded-url>` redirect; unwrap
 *  it back to the real destination. Protocol-relative `//host` becomes https. */
function decodeDdgHref(href: string): string {
  const enc = /[?&]uddg=([^&]+)/.exec(href)?.[1];

  if (enc !== undefined) {
    try {
      return decodeURIComponent(enc);
    } catch {
      return href;
    }
  }

  return href.startsWith("//") ? `https:${href}` : href;
}

function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().replace(/^site:/iu, "");

  if (trimmed.length === 0) {
    return null;
  }

  let host: string;

  try {
    host = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
      ? new URL(trimmed).hostname
      : (trimmed.split(/[/?#]/u)[0] ?? "");
  } catch {
    return null;
  }

  const normalized = host.toLowerCase().replace(/\.$/u, "");

  if (
    normalized.length === 0 ||
    normalized.includes(":") ||
    !/^[a-z0-9.-]+$/iu.test(normalized) ||
    normalized.split(".").some((part) => part.length === 0)
  ) {
    return null;
  }

  return validateFetchUrl(`https://${normalized}/`) === null
    ? null
    : normalized;
}

function domainsArg(args: Record<string, unknown>): string[] | null {
  const value = args.domains;

  if (value === undefined || value === null) {
    return [];
  }

  const rawDomains: string[] = [];

  if (typeof value === "string") {
    rawDomains.push(value);
  } else if (isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        return null;
      }

      rawDomains.push(item);
    }
  } else {
    return null;
  }

  const domains: string[] = [];

  for (const rawDomain of rawDomains) {
    const domain = normalizeDomain(rawDomain);

    if (domain === null) {
      return null;
    }

    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }

  return domains.slice(0, MAX_DOMAINS);
}

function scopedQuery(query: string, domains: readonly string[]): string {
  if (domains.length === 0) {
    return query;
  }

  const sites = domains.map((domain) => `site:${domain}`);
  const first = sites[0];

  if (first === undefined) {
    return query;
  }

  if (sites.length === 1) {
    return `${query} ${first}`;
  }

  return `${query} (${sites.join(" OR ")})`;
}

const ANCHOR_RE = /<a\b[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g;
const SNIPPET_RE = /<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
const HREF_RE = /href="([^"]*)"/;
const INNER_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/;

/** Extract results from DuckDuckGo HTML. Pure + synchronous so it's trivially
 *  testable against a captured markup fixture (no network). */
export function parseDuckDuckGoResults(html: string): ISearchResult[] {
  const snippets = [...html.matchAll(SNIPPET_RE)].map((m) =>
    stripHtml(m[1] ?? "")
  );
  const results: ISearchResult[] = [];
  let i = 0;

  for (const m of html.matchAll(ANCHOR_RE)) {
    const hrefV = HREF_RE.exec(m[0])?.[1];
    const innerV = INNER_RE.exec(m[0])?.[1];

    if (hrefV !== undefined && innerV !== undefined) {
      results.push({
        title: stripHtml(innerV),
        url: decodeDdgHref(hrefV),
        snippet: snippets[i] ?? "",
      });
    }

    i++;
  }

  return results;
}

/** Extract results from a SearXNG `format=json` response (untyped → narrowed). */
export function parseSearxngResults(json: unknown): ISearchResult[] {
  if (!isRecord(json) || !isArray(json.results)) {
    return [];
  }

  const out: ISearchResult[] = [];

  for (const item of json.results) {
    if (!isRecord(item)) {
      continue;
    }

    const url = typeof item.url === "string" ? item.url : "";

    if (url.length > 0) {
      out.push({
        title: typeof item.title === "string" ? item.title : "",
        url,
        snippet: typeof item.content === "string" ? item.content : "",
      });
    }
  }

  return out;
}

export function filterPublicResults(
  results: readonly ISearchResult[]
): ISearchResult[] {
  const out: ISearchResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const url = validateFetchUrl(result.url);

    if (url === null || seen.has(url.href)) {
      continue;
    }

    seen.add(url.href);
    out.push({ ...result, url: url.href });
  }

  return out;
}

export function formatResults(
  results: readonly ISearchResult[],
  limit: number = DEFAULT_MAX_RESULTS,
  annotate: (r: ISearchResult) => string = () => ""
): string {
  if (results.length === 0) {
    return "no results found.";
  }

  return results
    .slice(0, limit)
    .map((r, i) => {
      const head = r.title.length > 0 ? r.title : r.url;
      const snip = r.snippet.length > 0 ? `\n   ${r.snippet}` : "";
      const note = annotate(r);

      return `${String(i + 1)}. ${head}\n   ${r.url}${snip}${note.length > 0 ? `\n   ${note}` : ""}`;
    })
    .join("\n\n");
}

/** "→ reddit_thread post:\"abc\"" / "→ web_fetch", plus "· already read"
 *  when the result's source key is logged for the topic. */
export function readerNote(url: string, logged: ReadonlySet<string>): string {
  const route = routeUrl(url);
  const key = route?.key ?? webKey(url);
  const read = logged.has(key) ? " · already read" : "";

  return `→ ${route?.hint ?? "web_fetch"}${read}`;
}

function ddgRecencyParam(recency: WebSearchRecency | null): string | null {
  if (recency === "day") {
    return "d";
  }

  if (recency === "week") {
    return "w";
  }

  if (recency === "month") {
    return "m";
  }

  return recency === "year" ? "y" : null;
}

function configuredSearxngUrl(): string {
  return process.env.TSFORGE_SEARXNG_URL?.trim() ?? "";
}

function searchBackend(): WebSearchBackend | null {
  const configured = process.env.TSFORGE_WEB_SEARCH_BACKEND?.trim();

  if (configured === "duckduckgo" || configured === "searxng") {
    return configured;
  }

  if (configured !== undefined && configured.length > 0) {
    return null;
  }

  return configuredSearxngUrl().length > 0 ? "searxng" : "duckduckgo";
}

interface ISearchUrl {
  url: string;
  searxng: boolean;
}

interface ISearchUrlError {
  error: string;
}

function buildSearchUrl(
  query: string,
  recency: WebSearchRecency | null
): ISearchUrl | ISearchUrlError {
  const backend = searchBackend();
  const base = configuredSearxngUrl();
  const params = new URLSearchParams({ q: query });

  if (backend === null) {
    return {
      error:
        "web_search: TSFORGE_WEB_SEARCH_BACKEND must be `duckduckgo` or `searxng`.",
    };
  }

  if (backend === "searxng") {
    if (base.length === 0) {
      return {
        error:
          "web_search: TSFORGE_WEB_SEARCH_BACKEND=searxng requires TSFORGE_SEARXNG_URL.",
      };
    }

    const root = base.replace(/\/+$/, "");

    params.set("format", "json");

    if (recency !== null) {
      params.set("time_range", recency);
    }

    return {
      url: `${root}/search?${params.toString()}`,
      searxng: true,
    };
  }

  const url = new URL(DDG_ENDPOINT);
  const ddgRecency = ddgRecencyParam(recency);

  url.searchParams.set("q", query);

  if (ddgRecency !== null) {
    url.searchParams.set("df", ddgRecency);
  }

  return {
    url: url.href,
    searxng: false,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `web_search` — discover sources for a query and return ranked title/url/snippet
 * results. Free and keyless: DuckDuckGo's HTML endpoint by default, or a
 * self-hosted SearXNG instance when TSFORGE_SEARXNG_URL is set. No paid API, no
 * vendor lock-in — everything runs from the user's machine.
 */
export async function doWebSearch(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IWebSearchDeps = DEFAULT_DEPS
): Promise<string> {
  const queries = queriesArg(args);

  if (queries.length === 0) {
    return reject(
      ctx,
      "web_search",
      "web_search: `query` (or `queries`) must be a non-empty search string."
    );
  }

  if (
    args.recency !== undefined &&
    args.recency !== null &&
    recencyArg(args) === null
  ) {
    return reject(
      ctx,
      "web_search",
      "web_search: `recency` must be one of `day`, `week`, `month`, or `year`."
    );
  }

  const domains = domainsArg(args);

  if (domains === null) {
    return reject(
      ctx,
      "web_search",
      "web_search: `domains` must be a string or string[] of public hostnames."
    );
  }

  const recency = recencyArg(args);
  const lists: ISearchResult[][] = [];
  const failures: string[] = [];

  for (const query of queries) {
    const got = await searchOnce(query, domains, recency, ctx, deps);

    if (typeof got === "string") {
      failures.push(got);
    } else {
      lists.push(got);
    }
  }

  if (lists.length === 0) {
    return failures[0] ?? "web_search: no results.";
  }

  const topic = str(args, "topic").trim();
  const logged =
    topic.length > 0 ? await readSources(ctx.cwd, topic) : new Set<string>();
  const limit = maxResults(args) * Math.max(1, Math.min(lists.length, 2));
  const text = formatResults(
    filterPublicResults(mergeRoundRobin(lists)),
    limit,
    (r) => readerNote(r.url, logged)
  );
  const failed =
    failures.length > 0
      ? `\n\n(${String(failures.length)} of ${String(queries.length)} queries failed: ${failures[0] ?? ""})`
      : "";

  return `${text}${failed}`;
}

/** One backend query → results, or an error string. */
async function searchOnce(
  query: string,
  domains: readonly string[],
  recency: WebSearchRecency | null,
  ctx: IToolContext,
  deps: IWebSearchDeps
): Promise<ISearchResult[] | string> {
  const searchUrl = buildSearchUrl(scopedQuery(query, domains), recency);

  if ("error" in searchUrl) {
    return reject(ctx, "web_search", searchUrl.error);
  }

  const { url, searxng } = searchUrl;

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ web_search ${query}`,
  });

  let text: string;

  try {
    const res = await deps.fetchFn(url);

    if (!res.ok) {
      return `web_search: backend returned HTTP ${String(res.status)} — retry, or set TSFORGE_SEARXNG_URL to a self-hosted instance.`;
    }

    text = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_search: search request failed — ${msg}`;
  }

  return searxng
    ? parseSearxngResults(safeJson(text))
    : parseDuckDuckGoResults(text);
}

async function realSearchFetch(url: string): Promise<ISearchResponse> {
  return fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; tsforge-web-search/1.0)",
      accept: "text/html,application/json",
    },
  });
}

const DEFAULT_DEPS: IWebSearchDeps = { fetchFn: realSearchFetch };
