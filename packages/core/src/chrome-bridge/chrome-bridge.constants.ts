import type { BridgeMethod } from "./chrome-bridge.types";

/** Localhost port the tsforge session listens on for the extension. */
export const DEFAULT_BRIDGE_PORT = 47823;

/** Bumped on any incompatible frame change; hello with another value → 4002. */
export const PROTOCOL_VERSION = 1;

/** Fixed by the public `key` in packages/chrome-extension/static/manifest.json,
 *  so a load-unpacked install has this ID on every machine. The upgrade gate
 *  refuses any other Origin. */
export const EXTENSION_ID = "fjlgfemoomkhjnjdcajjgkcdpmjkgedi";

/** Title of the Chrome tab group the agent's tabs live in. */
export const GROUP_TITLE = "tsforge";

export const BRIDGE_PATH = "/bridge";

/** An upgraded socket that doesn't send a valid hello within this is closed. */
export const HELLO_TIMEOUT_MS = 3000;

export const CLOSE_CODE = {
  replaced: 4000,
  badToken: 4001,
  protocolMismatch: 4002,
} as const;

/** Per-method request timeouts. Navigation waits for the load to complete. */
export const METHOD_TIMEOUT_MS: Readonly<Record<BridgeMethod, number>> = {
  "tabs.list": 5000,
  "tabs.adopt": 5000,
  "tabs.open": 30_000,
  "tabs.navigate": 30_000,
  "tabs.close": 5000,
  "tabs.screenshot": 10_000,
  "page.read": 15_000,
  "page.click": 30_000,
  "page.scroll": 10_000,
};

/** One `browser_read` chunk. Stays under the 8192-char history prune threshold
 *  (context-hygiene) so a chunk is never middle-cut after the fact. */
export const READ_CHUNK_CHARS = 6000;
