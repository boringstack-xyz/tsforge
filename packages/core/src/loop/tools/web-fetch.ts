import { reject, str, type IToolContext } from "./tool-context";
import { htmlToReadableMarkdown } from "../../lib/html";
import {
  isPrivateHost,
  validateFetchUrl,
  assertPublicResolution,
  realResolve,
  type ResolveHost,
} from "../../lib/net/ssrf";

export { isPrivateHost, validateFetchUrl, type ResolveHost };

/** Default cap on returned content. Whole pages blow the context budget; the
 *  model can re-fetch with a higher `maxChars` when it genuinely needs more. */
export const WEB_FETCH_MAX_CHARS = 8000;

const MAX_ALLOWED_CHARS = WEB_FETCH_MAX_CHARS * 8;

export interface IFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface IWebFetchDeps {
  fetchFn: (url: string) => Promise<IFetchResponse>;
  /** HTML → readable markdown. Async: the real impl lazy-loads the extractor. */
  extract: (html: string, url: string) => Promise<string>;
}

function maxChars(args: Record<string, unknown>): number {
  const v = args.maxChars;

  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.min(Math.floor(v), MAX_ALLOWED_CHARS);
  }

  return WEB_FETCH_MAX_CHARS;
}

function truncate(content: string, max: number): string {
  const trimmed = content.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  const dropped = trimmed.length - max;

  return `${trimmed.slice(0, max)}\n\n…[truncated ${String(dropped)} chars — re-fetch with a higher maxChars to read more]`;
}

/**
 * `web_fetch` — retrieve a public web page and return its main content as
 * readable markdown. Fully local: one outbound GET, then the article text is
 * extracted on the user's own machine (no third-party API, no key). The URL is
 * vetted (http(s) + public host) before any network call.
 */
export async function doWebFetch(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: IWebFetchDeps = DEFAULT_DEPS
): Promise<string> {
  const url = validateFetchUrl(str(args, "url"));

  if (url === null) {
    return reject(
      ctx,
      "web_fetch",
      "web_fetch: `url` must be an absolute http(s) URL to a public host."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ web_fetch ${url.href}`,
  });

  let body: string;

  try {
    const res = await deps.fetchFn(url.href);

    if (!res.ok) {
      return `web_fetch: ${url.href} returned HTTP ${String(res.status)}.`;
    }

    body = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_fetch: failed to fetch ${url.href} — ${msg}`;
  }

  let content: string;

  try {
    content = await deps.extract(body, url.href);
  } catch (err) {
    // Self-contained: an extractor throw must become a tool-error STRING, not
    // propagate into the loop (the outer dispatch boundary would catch it, but a
    // handler owning its own failure gives the model a precise, actionable message).
    const msg = err instanceof Error ? err.message : "unknown error";

    return `web_fetch: fetched ${url.href} but failed to extract readable content — ${msg}`;
  }

  return truncate(content, maxChars(args));
}

/** Max redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

const FETCH_HEADERS = { "user-agent": "tsforge-web-fetch/1.0 (+local)" };

/** A raw HTTP response with enough surface to follow redirects. `fetch`'s real
 *  Response satisfies this; tests inject a fake to exercise the redirect guard. */
export interface IRawResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type RawFetch = (
  url: string,
  init: { redirect: "manual"; headers: Record<string, string> }
) => Promise<IRawResponse>;

/**
 * Follow redirects MANUALLY, re-validating EVERY hop's host. `redirect: "follow"`
 * is an SSRF hole: a public URL can 30x-redirect to localhost / the cloud-metadata
 * endpoint, which the one-time upfront host check never sees. Each Location is
 * vetted with `validateFetchUrl` (public http(s) host string) AND each hop's host
 * is DNS-resolved and re-checked against the private-IP classifier before we
 * connect — so a public-looking name resolving to a private IP is refused too.
 */
export async function fetchFollowingRedirects(
  start: string,
  rawFetch: RawFetch,
  resolve: ResolveHost = realResolve
): Promise<IFetchResponse> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicResolution(new URL(current), resolve);

    const res = await rawFetch(current, {
      redirect: "manual",
      headers: FETCH_HEADERS,
    });

    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    const location = res.headers.get("location");

    if (location === null || location.length === 0) {
      return res;
    }

    const next = new URL(location, current);

    if (validateFetchUrl(next.href) === null) {
      throw new Error(
        `blocked a redirect to a non-public host (${next.hostname})`
      );
    }

    current = next.href;
  }

  throw new Error("too many redirects");
}

async function realFetch(url: string): Promise<IFetchResponse> {
  return fetchFollowingRedirects(url, (target, init) => fetch(target, init));
}

const DEFAULT_DEPS: IWebFetchDeps = {
  fetchFn: realFetch,
  extract: htmlToReadableMarkdown,
};
