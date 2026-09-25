/**
 * Frame + payload parsing for the Chrome bridge. Pure and browser-safe: the
 * extension bundles this module, so it may import only other pure modules.
 * Every parser narrows `unknown` with guards and returns `null` on any shape it
 * doesn't recognize — neither side trusts the other's bytes.
 */
import { isArray, isRecord } from "../lib/guards/guards";
import { BRIDGE_PATH } from "./chrome-bridge.constants";
import type {
  BridgeErrorCode,
  BridgeMethod,
  ExtensionFrame,
  IClickResult,
  IPageSnapshot,
  IRefInfo,
  IScreenshotResult,
  IScrollResult,
  ITabInfo,
  RefKind,
  ServerFrame,
} from "./chrome-bridge.types";

const METHODS: ReadonlySet<string> = new Set<BridgeMethod>([
  "tabs.list",
  "tabs.adopt",
  "tabs.open",
  "tabs.navigate",
  "tabs.close",
  "tabs.screenshot",
  "page.read",
  "page.click",
  "page.scroll",
]);

const ERROR_CODES: ReadonlySet<string> = new Set<BridgeErrorCode>([
  "not_in_group",
  "denied",
  "stale_ref",
  "no_tab",
  "bad_url",
  "timeout",
  "disconnected",
  "internal",
]);

const REF_KINDS: ReadonlySet<string> = new Set<RefKind>([
  "link",
  "page",
  "expand",
  "summary",
]);

function isMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && METHODS.has(value);
}

function isErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

function isRefKind(value: unknown): value is RefKind {
  return typeof value === "string" && REF_KINDS.has(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseResponse(o: Record<string, unknown>): ExtensionFrame | null {
  if (!isInt(o.id)) {
    return null;
  }

  if (o.ok === true) {
    return { type: "res", id: o.id, ok: true, result: o.result };
  }

  const err = o.error;

  if (o.ok !== false || !isRecord(err) || !isErrorCode(err.code)) {
    return null;
  }

  const message = typeof err.message === "string" ? err.message : "";

  return {
    type: "res",
    id: o.id,
    ok: false,
    error: { code: err.code, message },
  };
}

function parseHello(o: Record<string, unknown>): ExtensionFrame | null {
  if (!isInt(o.protocol) || typeof o.token !== "string") {
    return null;
  }

  const extVersion = typeof o.extVersion === "string" ? o.extVersion : "";

  return { type: "hello", protocol: o.protocol, token: o.token, extVersion };
}

/** Parse a frame the EXTENSION sent (tsforge side). */
export function parseExtensionFrame(raw: string): ExtensionFrame | null {
  const o = parseJson(raw);

  if (!isRecord(o)) {
    return null;
  }

  switch (o.type) {
    case "hello":
      return parseHello(o);
    case "res":
      return parseResponse(o);
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/** Parse a frame TSFORGE sent (extension side). */
export function parseServerFrame(raw: string): ServerFrame | null {
  const o = parseJson(raw);

  if (!isRecord(o)) {
    return null;
  }

  if (o.type === "welcome" && isInt(o.protocol)) {
    return { type: "welcome", protocol: o.protocol };
  }

  if (o.type === "pong") {
    return { type: "pong" };
  }

  if (o.type === "req" && isInt(o.id) && isMethod(o.method)) {
    const params = isRecord(o.params) ? o.params : {};

    return { type: "req", id: o.id, method: o.method, params };
  }

  return null;
}

// ── upgrade gate ────────────────────────────────────────────────────────────

export interface IUpgradeRequest {
  path: string;
  host: string | null;
  origin: string | null;
}

/** Only our extension, on loopback, on the bridge path, may upgrade. The Host
 *  check defeats DNS rebinding (a web page resolving its own name to 127.0.0.1);
 *  the Origin check stops any web page or other extension from connecting. */
export function isAuthorizedUpgrade(
  req: IUpgradeRequest,
  port: number,
  extensionId: string
): boolean {
  const hosts = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];

  return (
    req.path === BRIDGE_PATH &&
    req.host !== null &&
    hosts.includes(req.host) &&
    req.origin === `chrome-extension://${extensionId}`
  );
}

// ── payloads ────────────────────────────────────────────────────────────────

function parseTab(value: unknown): ITabInfo | null {
  if (!isRecord(value) || !isInt(value.tabId)) {
    return null;
  }

  return {
    tabId: value.tabId,
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "",
    active: value.active === true,
    inGroup: value.inGroup === true,
    adopted: value.adopted === true,
  };
}

function parseList<T>(
  value: unknown,
  item: (v: unknown) => T | null
): T[] | null {
  if (!isArray(value)) {
    return null;
  }

  const out: T[] = [];

  for (const entry of value) {
    const parsed = item(entry);

    if (parsed !== null) {
      out.push(parsed);
    }
  }

  return out;
}

export function parseTabList(value: unknown): ITabInfo[] | null {
  return parseList(value, parseTab);
}

export function parseTabInfo(value: unknown): ITabInfo | null {
  return parseTab(value);
}

function parseRef(value: unknown): IRefInfo | null {
  if (!isRecord(value) || !isInt(value.ref) || !isRefKind(value.kind)) {
    return null;
  }

  const text = typeof value.text === "string" ? value.text : "";

  return typeof value.href === "string"
    ? { ref: value.ref, kind: value.kind, text, href: value.href }
    : { ref: value.ref, kind: value.kind, text };
}

export function parseSnapshot(value: unknown): IPageSnapshot | null {
  if (
    !isRecord(value) ||
    !isInt(value.snapshotId) ||
    typeof value.html !== "string"
  ) {
    return null;
  }

  return {
    snapshotId: value.snapshotId,
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    html: value.html,
    refs: parseList(value.refs, parseRef) ?? [],
    truncated: value.truncated === true,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseScrollResult(value: unknown): IScrollResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    scrollY: num(value.scrollY),
    scrollHeight: num(value.scrollHeight),
    atBottom: value.atBottom === true,
    grew: value.grew === true,
  };
}

export function parseClickResult(value: unknown): IClickResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const outcome =
    value.outcome === "navigated" || value.outcome === "expanded"
      ? value.outcome
      : "none";

  return { outcome, url: typeof value.url === "string" ? value.url : "" };
}

export function parseScreenshot(value: unknown): IScreenshotResult | null {
  return isRecord(value) &&
    typeof value.dataUrl === "string" &&
    value.dataUrl.startsWith("data:image/")
    ? { dataUrl: value.dataUrl }
    : null;
}
