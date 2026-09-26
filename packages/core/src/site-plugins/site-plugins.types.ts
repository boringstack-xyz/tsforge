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
  session: IBrowserSession;
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
  hosts: readonly string[];
  tools: readonly ISiteToolSchema[];
  /** Appended to the system prompt once, when the browser capability is on. */
  guidance: string;
  handlers: Readonly<Record<string, SitePluginHandler>>;
}

/** Why a bridge fetch failed, in terms a handler can turn into advice. */
export type FetchFailure =
  | { kind: "bridge"; message: string }
  | { kind: "http"; status: number; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "bad_body"; message: string };

export type FetchOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: FetchFailure };
