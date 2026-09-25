/**
 * The localhost WebSocket server the Chrome extension connects to. One per
 * PROCESS (`ensureBrowserBridge` memoizes): a `/clear` rebuilds the Session but
 * must not try to bind the port a second time.
 */
import { BridgeHub } from "./bridge-connection";
import { loadOrCreateBridgeToken } from "./bridge-token";
import { EXTENSION_ID, METHOD_TIMEOUT_MS } from "./chrome-bridge.constants";
import type {
  BridgeResult,
  BridgeStatus,
  IBrowserBridge,
  IBrowserSession,
} from "./chrome-bridge.types";
import { isAuthorizedUpgrade } from "./protocol";

export interface IStartBridgeOptions {
  port: number;
  token: string;
  extensionId?: string;
  helloTimeoutMs?: number;
}

function inUseBridge(port: number): IBrowserBridge {
  const result: BridgeResult = {
    ok: false,
    error: {
      code: "disconnected",
      message: `port ${String(port)} is owned by another tsforge session — the browser is driven from there`,
    },
  };

  return {
    port,
    status: (): BridgeStatus => "in-use",
    request: () => Promise.resolve(result),
    stop: () => undefined,
  };
}

function isAddrInUse(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const code = "code" in err ? err.code : undefined;

  return code === "EADDRINUSE" || /in use|EADDRINUSE/iu.test(err.message);
}

/** Bind the bridge. Resolves to an `in-use` bridge (never throws) when another
 *  process already owns the port. `port: 0` picks a free port (tests). */
export function startBrowserBridge(opts: IStartBridgeOptions): IBrowserBridge {
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  const hub = new BridgeHub({
    token: opts.token,
    ...(opts.helloTimeoutMs === undefined
      ? {}
      : { helloTimeoutMs: opts.helloTimeoutMs }),
  });

  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: opts.port,
      fetch(req, srv) {
        const url = new URL(req.url);
        const allowed = isAuthorizedUpgrade(
          {
            path: url.pathname,
            host: req.headers.get("host"),
            origin: req.headers.get("origin"),
          },
          srv.port ?? opts.port,
          extensionId
        );

        if (!allowed) {
          return new Response("forbidden", { status: 403 });
        }

        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(ws) {
          hub.onOpen(ws);
        },
        message(ws, message) {
          hub.onMessage(
            ws,
            typeof message === "string" ? message : message.toString()
          );
        },
        close(ws) {
          hub.onClose(ws);
        },
      },
    });
  } catch (err) {
    if (isAddrInUse(err)) {
      return inUseBridge(opts.port);
    }

    throw err;
  }

  const port = server.port ?? opts.port;

  return {
    port,
    status: (): BridgeStatus => (hub.connected ? "connected" : "listening"),
    request: (method, params) =>
      hub.request(method, params, METHOD_TIMEOUT_MS[method]),
    stop: () => {
      void server.stop(true);
    },
  };
}

let shared: Promise<IBrowserBridge> | null = null;

/** The process-wide bridge, started on first call (token created if absent). */
export function ensureBrowserBridge(port: number): Promise<IBrowserBridge> {
  shared ??= loadOrCreateBridgeToken().then((token) =>
    startBrowserBridge({ port, token })
  );

  return shared;
}

/** Fresh per-session browser state over the process-wide bridge. */
export async function openBrowserSession(
  port: number
): Promise<IBrowserSession> {
  return {
    bridge: await ensureBrowserBridge(port),
    pages: new Map(),
    lastTab: null,
    opened: new Set(),
  };
}
