/** Stack Exchange API v2.3 — read endpoints only. */
export const SE_API_HOST = "api.stackexchange.com";
export const SE_HOSTS = [SE_API_HOST] as const;
export const SITE = "se";
export const DEFAULT_SITE = "stackoverflow";

export const SE_SORTS = ["relevance", "votes", "activity", "creation"] as const;
export const MAX_SE_LIMIT = 50;
export const MAX_ANSWERS = 30;

const SITE_RE = /^[a-z0-9][a-z0-9.-]{1,40}$/u;

/** Hosts that are an SE site under their own domain → the API site name. */
const OWN_DOMAIN_SITES: Readonly<Record<string, string>> = {
  "stackoverflow.com": "stackoverflow",
  "superuser.com": "superuser",
  "serverfault.com": "serverfault",
  "askubuntu.com": "askubuntu",
  "mathoverflow.net": "mathoverflow.net",
  "stackapps.com": "stackapps",
};

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.find((a) => a === value) ?? fallback;
}

/** A site name from `stackoverflow`, `electronics`, `diy.stackexchange.com`. */
export function parseSite(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (s.length === 0) {
    return DEFAULT_SITE;
  }

  const fromHost = siteOfHost(s);

  if (fromHost !== null) {
    return fromHost;
  }

  return SITE_RE.test(s) && !s.includes("..") ? s : null;
}

export function siteOfHost(host: string): string | null {
  const h = host.replace(/^www\./u, "");
  const own = OWN_DOMAIN_SITES[h];

  if (own !== undefined) {
    return own;
  }

  const m = /^([a-z0-9-]+)\.stackexchange\.com$/u.exec(h);

  return m?.[1] !== undefined && m[1] !== "api" && m[1] !== "meta"
    ? m[1]
    : null;
}

export interface IQuestionRef {
  site: string;
  id: number;
}

/** `123` (+ site) or a question URL (`/questions/123/...`, `/q/123`). */
export function parseQuestionRef(
  raw: unknown,
  siteArg: unknown
): IQuestionRef | null {
  const s =
    typeof raw === "number"
      ? String(raw)
      : typeof raw === "string"
        ? raw.trim()
        : "";

  if (/^\d{1,10}$/u.test(s)) {
    const site = parseSite(siteArg);

    return site === null ? null : { site, id: Number(s) };
  }

  try {
    const url = new URL(s);
    const site = siteOfHost(url.hostname);
    const id = /^\/(?:questions|q)\/(\d{1,10})(?:\/|$)/u.exec(
      url.pathname
    )?.[1];

    return site === null || id === undefined ? null : { site, id: Number(id) };
  } catch {
    return null;
  }
}

function query(
  params: Record<string, string | undefined>,
  key: string
): string {
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v.length > 0) {
      q.set(k, v);
    }
  }

  if (key.length > 0) {
    q.set("key", key);
  }

  return q.toString();
}

export interface ISeSearchArgs {
  query: string;
  site: string;
  sort?: unknown;
  accepted?: unknown;
  limit?: unknown;
  page?: unknown;
}

export function searchPath(a: ISeSearchArgs, key: string): string {
  const limit =
    typeof a.limit === "number" && Number.isFinite(a.limit)
      ? Math.min(Math.max(Math.floor(a.limit), 1), MAX_SE_LIMIT)
      : 20;
  const page =
    typeof a.page === "number" && Number.isFinite(a.page)
      ? Math.max(Math.floor(a.page), 1)
      : 1;

  return `/2.3/search/advanced?${query(
    {
      q: a.query,
      site: a.site,
      sort: pick(a.sort, SE_SORTS, "relevance"),
      order: "desc",
      pagesize: String(limit),
      page: String(page),
      accepted: a.accepted === true ? "True" : undefined,
    },
    key
  )}`;
}

export function questionPath(ref: IQuestionRef, key: string): string {
  return `/2.3/questions/${String(ref.id)}?${query({ site: ref.site, filter: "withbody" }, key)}`;
}

export function answersPath(ref: IQuestionRef, key: string): string {
  return `/2.3/questions/${String(ref.id)}/answers?${query({ site: ref.site, sort: "votes", order: "desc", pagesize: String(MAX_ANSWERS), filter: "withbody" }, key)}`;
}
