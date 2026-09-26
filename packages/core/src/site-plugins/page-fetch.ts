/**
 * Fetch a site's data through the user's logged-in browser: ONE tab per host in
 * the tsforge group, reused for every request (a research run must not open a
 * tab per thread), a same-origin `page.fetch` inside it, paced per host, with
 * bounded retries on 429 / 5xx.
 */
import {
  parseFetchResult,
  parseTabInfo,
  parseTabList,
  type IBrowserSession,
  type IFetchResult,
} from "../chrome-bridge";
import { backoffMs, Pacer } from "./pacer";
import type { FetchOutcome } from "./site-plugins.types";

export const MAX_RATE_LIMIT_ATTEMPTS = 5;
export const MAX_SERVER_ERROR_ATTEMPTS = 3;

interface IHostState {
  pacer: Pacer;
  tabs: Map<string, number>;
}

/** Per-session state, dropped with the session. */
const STATE = new WeakMap<IBrowserSession, IHostState>();

function stateOf(session: IBrowserSession, pacer?: Pacer): IHostState {
  let state = STATE.get(session);

  if (state === undefined) {
    state = { pacer: pacer ?? new Pacer(), tabs: new Map() };
    STATE.set(session, state);
  }

  return state;
}

/** Tests inject a pacer with a fake clock. */
export function usePacer(session: IBrowserSession, pacer: Pacer): void {
  stateOf(session, pacer).pacer = pacer;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A tsforge-group tab currently on `host`: the remembered one if it is still
 *  there, else any group tab on the host, else a newly opened one. */
async function hostTab(
  session: IBrowserSession,
  host: string
): Promise<FetchOutcome<number>> {
  const state = stateOf(session);
  const listed = await session.bridge.request("tabs.list", {});

  if (!listed.ok) {
    return {
      ok: false,
      failure: { kind: "bridge", message: listed.error.message },
    };
  }

  const tabs = (parseTabList(listed.result) ?? []).filter(
    (t) => t.inGroup && hostOf(t.url) === host
  );
  const remembered = state.tabs.get(host);
  const pick = tabs.find((t) => t.tabId === remembered) ?? tabs[0];

  if (pick !== undefined) {
    state.tabs.set(host, pick.tabId);

    return { ok: true, value: pick.tabId };
  }

  const opened = await session.bridge.request("tabs.open", {
    url: `https://${host}/`,
  });
  const info = opened.ok ? parseTabInfo(opened.result) : null;

  if (info === null) {
    return {
      ok: false,
      failure: {
        kind: "bridge",
        message: opened.ok
          ? "tabs.open: unexpected reply"
          : opened.error.message,
      },
    };
  }

  state.tabs.set(host, info.tabId);
  session.opened.add(info.tabId);

  return { ok: true, value: info.tabId };
}

async function fetchOnce(
  session: IBrowserSession,
  tabId: number,
  url: string
): Promise<FetchOutcome<IFetchResult>> {
  const res = await session.bridge.request("page.fetch", { tabId, url });

  if (!res.ok) {
    return {
      ok: false,
      failure: {
        kind: "bridge",
        message: `${res.error.code}: ${res.error.message}`,
      },
    };
  }

  const value = parseFetchResult(res.result);

  return value === null
    ? {
        ok: false,
        failure: { kind: "bad_body", message: "page.fetch: unexpected reply" },
      }
    : { ok: true, value };
}

/** Classify one HTTP reply: done, retry after a delay, or a final failure. */
function judge(
  res: IFetchResult,
  attempt: number
): { done: FetchOutcome<string> } | { retryIn: number } {
  if (res.status >= 200 && res.status < 300) {
    return { done: { ok: true, value: res.body } };
  }

  if (res.status === 429) {
    return attempt < MAX_RATE_LIMIT_ATTEMPTS
      ? { retryIn: backoffMs(attempt, res.retryAfter) }
      : {
          done: {
            ok: false,
            failure: {
              kind: "rate_limited",
              message: `rate limited (HTTP 429) after ${String(attempt)} attempts — pause before more requests`,
            },
          },
        };
  }

  if (res.status >= 500 && attempt < MAX_SERVER_ERROR_ATTEMPTS) {
    return { retryIn: backoffMs(attempt, res.retryAfter) };
  }

  return {
    done: {
      ok: false,
      failure: {
        kind: "http",
        status: res.status,
        message: `HTTP ${String(res.status)}`,
      },
    },
  };
}

/**
 * GET `https://<host><path>` through the user's browser and return the body.
 * Re-resolves the host tab once if the remembered one went away (closed, or
 * the user navigated it elsewhere so the same-origin check fails).
 */
export async function pageFetchText(
  session: IBrowserSession,
  host: string,
  path: string
): Promise<FetchOutcome<string>> {
  const { pacer, tabs } = stateOf(session);
  const url = `https://${host}${path}`;

  for (let attempt = 1; ; attempt += 1) {
    const tab = await hostTab(session, host);

    if (!tab.ok) {
      return tab;
    }

    await pacer.wait(host);

    const res = await fetchOnce(session, tab.value, url);

    if (!res.ok) {
      // The tab left the host or vanished: forget it and resolve again, once.
      if (res.failure.kind === "bridge" && attempt === 1) {
        tabs.delete(host);
        continue;
      }

      return res;
    }

    const verdict = judge(res.value, attempt);

    if ("done" in verdict) {
      return verdict.done;
    }

    await pacer.backoff(host, verdict.retryIn);
  }
}

/** `pageFetchText` + JSON.parse. */
export async function pageFetchJson(
  session: IBrowserSession,
  host: string,
  path: string
): Promise<FetchOutcome<unknown>> {
  const res = await pageFetchText(session, host, path);

  if (!res.ok) {
    return res;
  }

  try {
    const value: unknown = JSON.parse(res.value);

    return { ok: true, value };
  } catch {
    return {
      ok: false,
      failure: {
        kind: "bad_body",
        message: `not JSON: ${res.value.slice(0, 200)}`,
      },
    };
  }
}

/** One line of advice for the model per failure kind. */
export function describeFailure(
  site: string,
  f: FetchOutcome<unknown>
): string {
  if (f.ok) {
    return "";
  }

  switch (f.failure.kind) {
    case "bridge":
      return `${site}: the Chrome extension couldn't make the request (${f.failure.message}). If it says disconnected, the user needs Chrome open with the tsforge extension paired (/browser); if it mentions the protocol, the extension needs reloading.`;
    case "rate_limited":
      return `${site}: ${f.failure.message}. Save notes on what you have, then continue more slowly.`;
    case "http":
      return f.failure.status === 403
        ? `${site}: HTTP 403 — the site refused the request (private/quarantined community, or the user is not logged in).`
        : f.failure.status === 404
          ? `${site}: HTTP 404 — not found (deleted, or the id/name is wrong).`
          : `${site}: ${f.failure.message}.`;
    case "bad_body":
      return `${site}: unexpected response — ${f.failure.message}`;
  }
}
