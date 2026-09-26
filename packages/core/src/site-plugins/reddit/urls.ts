/**
 * Reddit read endpoints — the ONLY URLs this plugin builds. Every path is a
 * `.json` view of a public page (or the read-only morechildren expansion);
 * nothing here can post, vote, subscribe or message.
 */
import {
  DEFAULT_MAX_COMMENTS,
  LISTING_SORTS,
  MAX_LISTING_LIMIT,
  SEARCH_SORTS,
  THREAD_SORTS,
  TIME_RANGES,
} from "./reddit.constants";

const POST_ID_RE = /^[a-z0-9]{1,12}$/u;
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/u;
const COMMENTS_PATH_RE = /\/comments\/([a-z0-9]{1,12})(?:\/|$)/u;
const SHORT_HOSTS = new Set(["redd.it"]);

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.find((a) => a === value) ?? fallback;
}

export function clampLimit(value: unknown, fallback: number): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;

  return Math.min(Math.max(n, 1), MAX_LISTING_LIMIT);
}

/** A post id from an id (`abc123`, `t3_abc123`) or any Reddit post URL. */
export function parsePostId(raw: string): string | null {
  const s = raw.trim();
  const bare = s.startsWith("t3_") ? s.slice(3) : s;

  if (POST_ID_RE.test(bare)) {
    return bare;
  }

  try {
    const url = new URL(s);

    if (SHORT_HOSTS.has(url.hostname)) {
      const id = url.pathname.slice(1);

      return POST_ID_RE.test(id) ? id : null;
    }

    return COMMENTS_PATH_RE.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** `r/Guitar`, `/r/Guitar/`, `Guitar` → `Guitar`; null when not a name. */
export function parseSubreddit(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^\/?r\//u, "")
    .replace(/\/+$/u, "");

  return SUBREDDIT_RE.test(name) ? name : null;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v.length > 0) {
      q.set(k, v);
    }
  }

  q.set("raw_json", "1");

  return q.toString();
}

export interface ISearchArgs {
  query: string;
  subreddit?: string;
  sort?: unknown;
  time?: unknown;
  limit?: unknown;
  after?: string;
}

export function searchPath(a: ISearchArgs): string {
  const base =
    a.subreddit === undefined
      ? "/search.json"
      : `/r/${a.subreddit}/search.json`;

  return `${base}?${query({
    q: a.query,
    restrict_sr: a.subreddit === undefined ? undefined : "1",
    sort: pick(a.sort, SEARCH_SORTS, "relevance"),
    t: pick(a.time, TIME_RANGES, "all"),
    limit: String(clampLimit(a.limit, 25)),
    after: a.after,
    type: "link",
  })}`;
}

export function listingPath(a: {
  subreddit: string;
  sort?: unknown;
  time?: unknown;
  limit?: unknown;
  after?: string;
}): string {
  const sort = pick(a.sort, LISTING_SORTS, "hot");

  return `/r/${a.subreddit}/${sort}.json?${query({
    t: sort === "top" ? pick(a.time, TIME_RANGES, "all") : undefined,
    limit: String(clampLimit(a.limit, 25)),
    after: a.after,
  })}`;
}

export function subredditSearchPath(q: string, limit: unknown): string {
  return `/subreddits/search.json?${query({ q, limit: String(clampLimit(limit, 15)) })}`;
}

export function threadSort(value: unknown): (typeof THREAD_SORTS)[number] {
  return pick(value, THREAD_SORTS, "top");
}

export function threadPath(postId: string, sort: unknown): string {
  return `/comments/${postId}.json?${query({
    limit: String(DEFAULT_MAX_COMMENTS),
    sort: threadSort(sort),
  })}`;
}

/** "Continue this thread": the subtree under one comment. */
export function continuePath(
  postId: string,
  commentId: string,
  sort: unknown
): string {
  return `/comments/${postId}/_/${commentId}.json?${query({ sort: threadSort(sort) })}`;
}

/** Collapsed replies ("load more comments"): ≤100 ids per call. */
export function moreChildrenPath(
  postId: string,
  ids: readonly string[],
  sort: unknown
): string {
  return `/api/morechildren.json?${query({
    link_id: `t3_${postId}`,
    children: ids.join(","),
    api_type: "json",
    sort: threadSort(sort),
  })}`;
}

export function postUrl(permalink: string): string {
  return `https://www.reddit.com${permalink}`;
}
