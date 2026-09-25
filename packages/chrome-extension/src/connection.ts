/**
 * The extension's side of the bridge: connect to tsforge on localhost, say
 * hello with the pairing token, answer requests, ping to keep the MV3 service
 * worker alive, and reconnect with backoff when tsforge isn't running.
 * Transport + timers are injected so the state machine is testable.
 */
import { parseServerFrame } from "../../core/src/chrome-bridge/protocol";
import type {
  BridgeMethod,
  IRequestFrame,
} from "../../core/src/chrome-bridge/chrome-bridge.types";
import {
  CLOSE_CODE,
  PROTOCOL_VERSION,
} from "../../core/src/chrome-bridge/chrome-bridge.constants";
import type { HandlerResult } from "./extension.types";

export const PING_MS = 20_000;
export const MAX_BACKOFF_MS = 30_000;

export type ConnectionStatus =
  "connecting" | "connected" | "waiting" | "bad-token" | "no-token";

/** The subset of the browser WebSocket used. */
export interface IWsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface IConnectionDeps {
  createSocket: (url: string) => IWsLike;
  handle: (
    method: BridgeMethod,
    params: Record<string, unknown>
  ) => Promise<HandlerResult>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onStatus: (status: ConnectionStatus) => void;
  version: string;
}

export interface IConnectionConfig {
  token: string;
  port: number;
}

/** 1s, 2s, 4s … capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt));
}

export class Connection {
  private socket: IWsLike | null = null;
  private config: IConnectionConfig | null = null;
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private halted = false;

  constructor(private readonly deps: IConnectionDeps) {}

  /** (Re)configure and connect. A new token clears a bad-token halt. */
  configure(config: IConnectionConfig): void {
    this.config = config;
    this.halted = false;
    this.attempt = 0;
    this.drop();
    this.ensure();
  }

  /** Connect if idle (safe to call often — e.g. from a keep-alive alarm). */
  ensure(): void {
    if (this.socket !== null || this.halted || this.retryTimer !== null) {
      return;
    }

    if (this.config === null || this.config.token.length === 0) {
      this.deps.onStatus("no-token");

      return;
    }

    this.open(this.config);
  }

  private open(config: IConnectionConfig): void {
    const sock = this.deps.createSocket(
      `ws://127.0.0.1:${String(config.port)}/bridge`
    );

    this.socket = sock;
    this.deps.onStatus("connecting");

    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          token: config.token,
          extVersion: this.deps.version,
        })
      );
    };

    sock.onmessage = (ev) => {
      this.onMessage(sock, typeof ev.data === "string" ? ev.data : "");
    };

    sock.onclose = (ev) => {
      this.onClose(sock, ev.code);
    };

    sock.onerror = () => undefined;
  }

  private onMessage(sock: IWsLike, raw: string): void {
    const frame = parseServerFrame(raw);

    if (frame === null || sock !== this.socket) {
      return;
    }

    if (frame.type === "welcome") {
      this.attempt = 0;
      this.deps.onStatus("connected");
      this.startPing(sock);

      return;
    }

    if (frame.type === "req") {
      void this.answer(sock, frame);
    }
  }

  private async answer(sock: IWsLike, req: IRequestFrame): Promise<void> {
    let res: HandlerResult;

    try {
      res = await this.deps.handle(req.method, req.params);
    } catch (err) {
      res = {
        ok: false,
        error: {
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    sock.send(JSON.stringify({ type: "res", id: req.id, ...res }));
  }

  private startPing(sock: IWsLike): void {
    this.stopPing();
    this.pingTimer = this.deps.setTimer(() => {
      this.pingTimer = null;

      if (sock === this.socket) {
        sock.send(JSON.stringify({ type: "ping" }));
        this.startPing(sock);
      }
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      this.deps.clearTimer(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private onClose(sock: IWsLike, code: number): void {
    if (sock !== this.socket) {
      return;
    }

    this.socket = null;
    this.stopPing();

    if (code === CLOSE_CODE.badToken) {
      this.halted = true;
      this.deps.onStatus("bad-token");

      return;
    }

    this.deps.onStatus("waiting");

    // Replaced by our own newer connection: that one is live, don't fight it.
    if (code === CLOSE_CODE.replaced) {
      return;
    }

    const delay = backoffMs(this.attempt);

    this.attempt += 1;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.ensure();
    }, delay);
  }

  private drop(): void {
    if (this.retryTimer !== null) {
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }

    this.stopPing();
    const sock = this.socket;

    this.socket = null;
    sock?.close();
  }
}
