/** Hacker News via Algolia's official HN API — read endpoints only. */
export const HN_API_HOST = "hn.algolia.com";
export const HN_HOSTS = [HN_API_HOST] as const;
export const SITE = "hn";

export const HN_SORTS = ["relevance", "date"] as const;
export const HN_TYPES = ["story", "comment"] as const;
export const HN_TIMES = ["day", "week", "month", "year", "all"] as const;
export const MAX_HN_LIMIT = 50;

const RANGE_SECONDS: Readonly<Record<string, number>> = {
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
  year: 365 * 86_400,
};

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.find((a) => a === value) ?? fallback;
}

/** An item id from `8863`, `https://news.ycombinator.com/item?id=8863`. */
export function parseItemId(raw: unknown): number | null {
  const s =
    typeof raw === "number"
      ? String(raw)
      : typeof raw === "string"
        ? raw.trim()
        : "";

  if (/^\d{1,9}$/u.test(s)) {
    return Number(s);
  }

  try {
    const url = new URL(s);
    const id = url.searchParams.get("id") ?? "";

    return url.hostname === "news.ycombinator.com" && /^\d{1,9}$/u.test(id)
      ? Number(id)
      : null;
  } catch {
    return null;
  }
}

export interface IHnSearchArgs {
  query: string;
  sort?: unknown;
  type?: unknown;
  time?: unknown;
  limit?: unknown;
  page?: unknown;
}

export function searchPath(a: IHnSearchArgs, nowSeconds: number): string {
  const endpoint =
    pick(a.sort, HN_SORTS, "relevance") === "date"
      ? "search_by_date"
      : "search";
  const time = pick(a.time, HN_TIMES, "all");
  const limit =
    typeof a.limit === "number" && Number.isFinite(a.limit)
      ? Math.min(Math.max(Math.floor(a.limit), 1), MAX_HN_LIMIT)
      : 20;
  const page =
    typeof a.page === "number" && Number.isFinite(a.page)
      ? Math.max(Math.floor(a.page), 0)
      : 0;
  const q = new URLSearchParams({
    query: a.query,
    tags: pick(a.type, HN_TYPES, "story"),
    hitsPerPage: String(limit),
    page: String(page),
  });
  const range = RANGE_SECONDS[time];

  if (range !== undefined) {
    q.set("numericFilters", `created_at_i>${String(nowSeconds - range)}`);
  }

  return `/api/v1/${endpoint}?${q.toString()}`;
}

export function itemPath(id: number): string {
  return `/api/v1/items/${String(id)}`;
}

export function itemUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${String(id)}`;
}
