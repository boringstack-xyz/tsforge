/**
 * Which `page.fetch` requests the extension will make. Compiled in — tsforge
 * sends only a URL, and nothing it sends can widen this list. A request is
 * allowed only when it is https, to the SAME origin the tab is showing, and
 * that host belongs to a built-in tsforge site plugin.
 */

/** Hosts built-in site plugins read from. Keep in sync with the core plugin
 *  registry (a test fails when they differ). */
export const FETCH_HOSTS: readonly string[] = [
  "old.reddit.com",
  "www.reddit.com",
];

/** Response bodies larger than this are refused (truncated JSON is useless). */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;

const TEXT_TYPE_RE =
  /^(?:application\/(?:[a-z0-9.+-]*\+)?json|text\/[a-z0-9.+-]+)(?:\s*;|$)/iu;

/** Why `raw` may not be fetched from a tab on `tabUrl`, or null when it may. */
export function fetchUrlProblem(raw: unknown, tabUrl: string): string | null {
  if (typeof raw !== "string") {
    return "missing url";
  }

  let url: URL;
  let tab: URL;

  try {
    url = new URL(raw);
    tab = new URL(tabUrl);
  } catch {
    return "not a valid URL";
  }

  if (url.protocol !== "https:") {
    return "only https URLs can be fetched";
  }

  if (url.origin !== tab.origin) {
    return `the tab is on ${tab.origin}, not ${url.origin} — page.fetch is same-origin only`;
  }

  if (url.username !== "" || url.password !== "") {
    return "URLs with credentials are not allowed";
  }

  return FETCH_HOSTS.includes(url.hostname)
    ? null
    : `${url.hostname} is not a site tsforge has a plugin for`;
}

export function isTextContentType(type: string): boolean {
  return TEXT_TYPE_RE.test(type.trim());
}
