/**
 * Wire + domain types for the tsforge ⇄ Chrome-extension bridge. Browser-safe:
 * the extension bundles `protocol.ts` (and therefore these types) too, so no
 * `node:` / Bun imports belong here.
 */

/** Everything tsforge can ask the extension to do. Read + navigate only — there
 *  is deliberately no method that types, submits, or clicks arbitrary elements. */
export type BridgeMethod =
  | "tabs.list"
  | "tabs.adopt"
  | "tabs.open"
  | "tabs.navigate"
  | "tabs.close"
  | "tabs.screenshot"
  | "page.read"
  | "page.click"
  | "page.scroll";

export type BridgeErrorCode =
  | "not_in_group"
  | "denied"
  | "stale_ref"
  | "no_tab"
  | "bad_url"
  | "timeout"
  | "disconnected"
  | "internal";

// ── extension → tsforge ─────────────────────────────────────────────────────

export interface IHelloFrame {
  type: "hello";
  protocol: number;
  token: string;
  extVersion: string;
}

export interface IBridgeError {
  code: BridgeErrorCode;
  message: string;
}

export interface IResultFrame {
  type: "res";
  id: number;
  ok: true;
  result: unknown;
}

export interface IErrorFrame {
  type: "res";
  id: number;
  ok: false;
  error: IBridgeError;
}

export interface IPingFrame {
  type: "ping";
}

export type ExtensionFrame =
  IHelloFrame | IResultFrame | IErrorFrame | IPingFrame;

// ── tsforge → extension ─────────────────────────────────────────────────────

export interface IWelcomeFrame {
  type: "welcome";
  protocol: number;
}

export interface IRequestFrame {
  type: "req";
  id: number;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface IPongFrame {
  type: "pong";
}

export type ServerFrame = IWelcomeFrame | IRequestFrame | IPongFrame;

// ── result payloads ─────────────────────────────────────────────────────────

export interface ITabInfo {
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  /** In the tsforge tab group (the only tabs the agent may act on). */
  inGroup: boolean;
  /** The user's own tab that tsforge adopted (close ⇒ ungroup, never close). */
  adopted: boolean;
}

export type RefKind = "link" | "page" | "expand" | "summary";

export interface IRefInfo {
  ref: number;
  kind: RefKind;
  text: string;
  href?: string;
}

export interface IPageSnapshot {
  snapshotId: number;
  url: string;
  title: string;
  /** Sanitized structural HTML; allowed clickables carry `data-tsforge-ref`. */
  html: string;
  refs: IRefInfo[];
  truncated: boolean;
}

export interface IScrollResult {
  scrollY: number;
  scrollHeight: number;
  atBottom: boolean;
  grew: boolean;
}

export interface IClickResult {
  /** "navigated" (followed a link), "expanded" (DOM changed in place), "none". */
  outcome: "navigated" | "expanded" | "none";
  url: string;
}

export interface IScreenshotResult {
  dataUrl: string;
}

// ── the bridge as tsforge sees it ───────────────────────────────────────────

export type BridgeResult =
  { ok: true; result: unknown } | { ok: false; error: IBridgeError };

/** `listening`: port bound, no extension yet. `connected`: extension paired.
 *  `in-use`: another tsforge process owns the port. */
export type BridgeStatus = "listening" | "connected" | "in-use";

export interface IBrowserBridge {
  readonly port: number;
  status(): BridgeStatus;
  /** Never rejects — failures come back as `{ ok: false }`. */
  request(
    method: BridgeMethod,
    params: Record<string, unknown>
  ): Promise<BridgeResult>;
  stop(): void;
}

/** A rendered page kept between `browser_read` calls so chunk 2…N don't
 *  re-snapshot, and so `browser_click` knows which snapshot its ref came from. */
export interface ICachedPage {
  snapshotId: number;
  url: string;
  title: string;
  mode: "article" | "full";
  chunks: string[];
  refs: IRefInfo[];
  truncated: boolean;
}

/** Per-session browser state carried on the tool context. */
export interface IBrowserSession {
  bridge: IBrowserBridge;
  pages: Map<number, ICachedPage>;
  lastTab: number | null;
  /** Tabs tsforge opened this session (for the "N tabs open" nudge). */
  opened: Set<number>;
}

/** The subset of a WebSocket the connection hub needs (Bun's ServerWebSocket
 *  satisfies it; tests pass a fake). */
export interface ISocketLike {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}
