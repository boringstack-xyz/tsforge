/**
 * The connection hub: owns at most ONE authenticated extension socket, the
 * pending-request table, and the serialized request queue. Transport-free —
 * `bridge-server` feeds it socket events; tests feed it a fake socket.
 */
import { timingSafeEqual } from "node:crypto";
import {
  CLOSE_CODE,
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "./chrome-bridge.constants";
import type {
  BridgeMethod,
  BridgeResult,
  IHelloFrame,
  ISocketLike,
} from "./chrome-bridge.types";
import { parseExtensionFrame } from "./protocol";

interface IPending {
  resolve: (result: BridgeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface IBridgeHubOptions {
  token: string;
  helloTimeoutMs?: number;
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function failure(
  code: "timeout" | "disconnected",
  message: string
): BridgeResult {
  return { ok: false, error: { code, message } };
}

export class BridgeHub {
  private readonly token: string;
  private readonly helloTimeoutMs: number;
  private active: ISocketLike | null = null;
  private readonly helloTimers = new Map<
    ISocketLike,
    ReturnType<typeof setTimeout>
  >();
  private readonly pending = new Map<number, IPending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: IBridgeHubOptions) {
    this.token = opts.token;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.active !== null;
  }

  /** A socket upgraded; it has `helloTimeoutMs` to authenticate. */
  onOpen(sock: ISocketLike): void {
    const timer = setTimeout(() => {
      this.helloTimers.delete(sock);
      sock.close(CLOSE_CODE.badToken, "no hello");
    }, this.helloTimeoutMs);

    this.helloTimers.set(sock, timer);
  }

  onMessage(sock: ISocketLike, raw: string): void {
    const frame = parseExtensionFrame(raw);

    if (frame === null) {
      return;
    }

    if (frame.type === "hello") {
      this.onHello(sock, frame);

      return;
    }

    // Everything but hello requires the socket to be the authenticated one.
    if (sock !== this.active) {
      return;
    }

    if (frame.type === "ping") {
      sock.send(JSON.stringify({ type: "pong" }));

      return;
    }

    const entry = this.pending.get(frame.id);

    if (entry === undefined) {
      return;
    }

    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.resolve(
      frame.ok
        ? { ok: true, result: frame.result }
        : { ok: false, error: frame.error }
    );
  }

  onClose(sock: ISocketLike): void {
    this.clearHelloTimer(sock);

    if (sock === this.active) {
      this.active = null;
      this.rejectAll("Chrome extension disconnected");
    }
  }

  /** Send one request; requests run one at a time (the browser is a single
   *  shared resource). Never rejects. */
  request(
    method: BridgeMethod,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BridgeResult> {
    const run = (): Promise<BridgeResult> =>
      this.send(method, params, timeoutMs);
    const next = this.queue.then(run, run);

    this.queue = next;

    return next;
  }

  private send(
    method: BridgeMethod,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BridgeResult> {
    const sock = this.active;

    if (sock === null) {
      return Promise.resolve(
        failure("disconnected", "Chrome extension not connected")
      );
    }

    const id = this.nextId;

    this.nextId += 1;

    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          failure("timeout", `${method} timed out after ${String(timeoutMs)}ms`)
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, timer });
      sock.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private onHello(sock: ISocketLike, hello: IHelloFrame): void {
    this.clearHelloTimer(sock);

    if (!tokensMatch(hello.token, this.token)) {
      sock.close(CLOSE_CODE.badToken, "bad token");

      return;
    }

    if (hello.protocol !== PROTOCOL_VERSION) {
      sock.close(CLOSE_CODE.protocolMismatch, "protocol mismatch");

      return;
    }

    const previous = this.active;

    this.active = sock;

    if (previous !== null && previous !== sock) {
      this.rejectAll("Chrome extension reconnected");
      previous.close(CLOSE_CODE.replaced, "replaced");
    }

    sock.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION }));
  }

  private clearHelloTimer(sock: ISocketLike): void {
    const timer = this.helloTimers.get(sock);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.helloTimers.delete(sock);
    }
  }

  private rejectAll(message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(failure("disconnected", message));
      this.pending.delete(id);
    }
  }
}
