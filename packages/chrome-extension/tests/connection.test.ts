import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  Connection,
  type ConnectionStatus,
  type IWsLike,
} from "../src/connection";

class FakeWs implements IWsLike {
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  serverSends(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function harness() {
  const sockets: FakeWs[] = [];
  const statuses: ConnectionStatus[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const conn = new Connection({
    createSocket: (url) => {
      const s = new FakeWs(url);

      sockets.push(s);

      return s;
    },
    handle: async (method, params) => ({
      ok: true,
      result: { method, params },
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };

      timers.push(t);

      return t;
    },
    clearTimer: (h: any) => {
      h.cleared = true;
    },
    onStatus: (s) => statuses.push(s),
    version: "0.1.0",
  });

  return { conn, sockets, statuses, timers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("backoffMs", () => {
  test("1s doubling to a 30s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe("Connection", () => {
  test("no token → no socket, status no-token", () => {
    const h = harness();

    h.conn.configure({ token: "", port: 47823 });
    expect(h.sockets).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe("no-token");
  });

  test("hello on open, connected on welcome, answers requests by id", async () => {
    const h = harness();

    h.conn.configure({ token: "tok", port: 47823 });
    const ws = h.sockets[0]!;

    expect(ws.url).toBe("ws://127.0.0.1:47823/bridge");
    ws.onopen?.();
    expect(ws.sent[0]).toEqual({
      type: "hello",
      protocol: 1,
      token: "tok",
      extVersion: "0.1.0",
    });
    ws.serverSends({ type: "welcome", protocol: 1 });
    expect(h.statuses.at(-1)).toBe("connected");
    ws.serverSends({ type: "req", id: 5, method: "tabs.list", params: {} });
    await flush();
    expect(ws.sent.at(-1)).toEqual({
      type: "res",
      id: 5,
      ok: true,
      result: { method: "tabs.list", params: {} },
    });
  });

  test("unknown request methods are ignored (never reach the handlers)", async () => {
    const h = harness();

    h.conn.configure({ token: "tok", port: 1 });
    const ws = h.sockets[0]!;

    ws.onopen?.();
    ws.serverSends({
      type: "req",
      id: 6,
      method: "page.type",
      params: { text: "hi" },
    });
    await flush();
    expect(ws.sent.filter((f) => f.type === "res")).toHaveLength(0);
  });

  test("pings every 20s once connected", () => {
    const h = harness();

    h.conn.configure({ token: "tok", port: 1 });
    const ws = h.sockets[0]!;

    ws.onopen?.();
    ws.serverSends({ type: "welcome", protocol: 1 });
    const ping = h.timers.find((t) => t.ms === 20_000)!;

    ping.fn();
    expect(ws.sent.at(-1)).toEqual({ type: "ping" });
  });

  test("close → waiting, reconnect after backoff", () => {
    const h = harness();

    h.conn.configure({ token: "tok", port: 1 });
    h.sockets[0]!.onclose?.({ code: 1006 });
    expect(h.statuses.at(-1)).toBe("waiting");
    const retry = h.timers.at(-1)!;

    expect(retry.ms).toBe(1000);
    retry.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.onclose?.({ code: 1006 });
    expect(h.timers.at(-1)!.ms).toBe(2000);
  });

  test("bad token (4001) halts until reconfigured", () => {
    const h = harness();

    h.conn.configure({ token: "wrong", port: 1 });
    h.sockets[0]!.onclose?.({ code: 4001 });
    expect(h.statuses.at(-1)).toBe("bad-token");
    h.conn.ensure();
    expect(h.sockets).toHaveLength(1);
    h.conn.configure({ token: "right", port: 1 });
    expect(h.sockets).toHaveLength(2);
  });

  test("ensure() while a socket is open does not open another", () => {
    const h = harness();

    h.conn.configure({ token: "tok", port: 1 });
    h.conn.ensure();
    h.conn.ensure();
    expect(h.sockets).toHaveLength(1);
  });
});
