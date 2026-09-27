/**
 * Fetch a public JSON API directly (no browser) for "direct" site plugins —
 * Hacker News (Algolia) and Stack Exchange. https only, and only to a host the
 * plugin declares; paced per host with the same 429/5xx backoff as page.fetch,
 * because a long research run makes hundreds of calls to one API.
 */
import { isPrivateHost } from "../lib/net/ssrf";
import { Pacer } from "./pacer";
import { judge } from "./page-fetch";
import type { FetchOutcome } from "./site-plugins.types";

export const DIRECT_TIMEOUT_MS = 20_000;
export const MAX_DIRECT_BYTES = 5 * 1024 * 1024;

const USER_AGENT = "tsforge-research/1.0 (+https://tsforge.dev)";

export interface IDirectFetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  pacer: Pacer;
}

/** Process-wide: rate limits are per IP, not per session. */
let deps: IDirectFetchDeps = {
  fetch: (url, init) => fetch(url, init),
  pacer: new Pacer(),
};

/** Tests swap the network and the clock; returns the previous deps. */
export function setDirectFetchDeps(next: IDirectFetchDeps): IDirectFetchDeps {
  const prev = deps;

  deps = next;

  return prev;
}

function fail(message: string, status?: number): FetchOutcome<never> {
  return status === undefined
    ? { ok: false, failure: { kind: "bad_body", message } }
    : { ok: false, failure: { kind: "http", status, message } };
}

async function once(
  url: string
): Promise<{ status: number; body: string; retryAfter?: string } | string> {
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
    const body = await res.text();
    const retry = res.headers.get("retry-after");

    if (body.length > MAX_DIRECT_BYTES) {
      return "response larger than 5 MB";
    }

    return {
      status: res.status,
      body,
      ...(retry === null ? {} : { retryAfter: retry }),
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** GET `https://<host><path>` and parse JSON. `hosts` are the plugin's own. */
export async function directFetchJson(
  hosts: readonly string[],
  host: string,
  path: string
): Promise<FetchOutcome<unknown>> {
  if (!hosts.includes(host) || isPrivateHost(host)) {
    return fail(`${host} is not a host this plugin reads from`);
  }

  const url = `https://${host}${path}`;

  for (let attempt = 1; ; attempt += 1) {
    await deps.pacer.wait(host);

    const res = await once(url);

    if (typeof res === "string") {
      return {
        ok: false,
        failure: { kind: "network", message: `request failed: ${res}` },
      };
    }

    const verdict = judge(res, attempt);

    if ("retryIn" in verdict) {
      await deps.pacer.backoff(host, verdict.retryIn);
      continue;
    }

    if (!verdict.done.ok) {
      return verdict.done;
    }

    try {
      const value: unknown = JSON.parse(verdict.done.value);

      return { ok: true, value };
    } catch {
      return fail(`not JSON: ${verdict.done.value.slice(0, 200)}`);
    }
  }
}

/** Honour an API-requested pause (Stack Exchange's `backoff` seconds). */
export async function backoffHost(
  host: string,
  seconds: number
): Promise<void> {
  if (seconds > 0) {
    await deps.pacer.backoff(host, seconds * 1000);
  }
}
