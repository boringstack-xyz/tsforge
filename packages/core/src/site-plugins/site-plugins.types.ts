import type { IBrowserSession } from "../chrome-bridge";

/** An OpenAI-style tool schema a site plugin advertises. */
export interface ISiteToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Everything a plugin handler may touch. Deliberately narrower than the
 *  harness tool context: a plugin reads a site through the bridge, downloads
 *  public media, and writes under notes/ — nothing else. */
export interface ISitePluginContext {
  /** The Chrome bridge session — present for browser plugins (the harness
   *  never calls one without it), absent for direct plugins when the bridge is
   *  off. */
  session?: IBrowserSession;
  /** Keys per-session plugin state (chunk caches, read sets): the browser
   *  session when there is one, else a stable per-workspace object. */
  stateKey: object;
  cwd: string;
  /** Progress lines for the UI (`↳ reddit_thread abc123`). */
  progress: (message: string) => void;
}

/** A handler returns the tool result text and never throws. */
export type SitePluginHandler = (
  args: Record<string, unknown>,
  ctx: ISitePluginContext
) => Promise<string>;

/**
 * A built-in site plugin: an expert way to research one site. `hosts` are the
 * only origins its tools fetch from through the bridge — and the extension
 * independently refuses any host not compiled into its own allowlist.
 */
export interface ISitePlugin {
  id: string;
  /** `browser`: reads through the user's logged-in Chrome (page.fetch), offered
   *  only with the bridge. `direct`: a public JSON API tsforge calls itself,
   *  offered whenever the session can research (web tools or the bridge). */
  transport: "browser" | "direct";
  hosts: readonly string[];
  tools: readonly ISiteToolSchema[];
  /** Appended to the system prompt once, when the browser capability is on. */
  guidance: string;
  handlers: Readonly<Record<string, SitePluginHandler>>;
  /** The reader for a URL this plugin owns (for web_search hints and
   *  web_fetch delegation), or null. */
  route?: (url: URL) => ISiteRoute | null;
}

/** Which tool reads a URL, with what arguments, and its sources.md key. */
export interface ISiteRoute {
  tool: string;
  args: Record<string, unknown>;
  /** e.g. `reddit:abc12`, `hn:4214`, `se:stackoverflow/123`. */
  key: string;
  /** Short form for a result line: `reddit_thread post:"abc12"`. */
  hint: string;
}

/** Why a bridge fetch failed, in terms a handler can turn into advice. */
export type FetchFailure =
  | { kind: "bridge"; message: string }
  | { kind: "network"; message: string }
  | { kind: "http"; status: number; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "bad_body"; message: string };

export type FetchOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: FetchFailure };
