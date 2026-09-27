/**
 * The sources.md key for an ordinary web page: `web:<12 hex of sha1>` of the
 * URL normalised so trivially different links to one page share a key (no
 * fragment, no tracking params, no trailing slash, lower-case host).
 */
import { createHash } from "node:crypto";

const TRACKING_PARAM = /^(?:utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src)$/iu;

export function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);

    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");

    for (const key of url.searchParams.keys()) {
      if (TRACKING_PARAM.test(key)) {
        url.searchParams.delete(key);
      }
    }

    return url.href.replace(/\/+(\?|$)/u, "$1");
  } catch {
    return raw.trim();
  }
}

export function webKey(raw: string): string {
  return `web:${createHash("sha1").update(normaliseUrl(raw)).digest("hex").slice(0, 12)}`;
}
