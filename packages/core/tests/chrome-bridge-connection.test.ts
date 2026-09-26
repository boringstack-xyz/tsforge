import { describe, expect, test } from "bun:test";
import { BridgeHub } from "../src/chrome-bridge/bridge-connection";
import { PROTOCOL_VERSION } from "../src/chrome-bridge/chrome-bridge.constants";
import type { ISocketLike } from "../src/chrome-bridge/chrome-bridge.types";

class FakeSocket implements ISocketLike {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  last(): any {
    return this.sent.at(-1);
  }
}

const TOKEN = "a-very-secret-token-123";

function hello(token = TOKEN, protocol = PROTOCOL_VERSION): string {
  return JSON.stringify({ type: "hello", protocol, token, extVersion: "t" });
}

function paired(hub: BridgeHub): FakeSocket {
  const sock = new FakeSocket();

  hub.onOpen(sock);
  hub.onMessage(sock, hello());

  return sock;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BridgeHub auth", () => {
  test("valid hello → welcome + connected", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);

    expect(sock.last()).toEqual({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
    });
    expect(hub.connected).toBe(true);
    expect(sock.closed).toBeNull();
  });

  test("bad token → 4001, not connected", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = new FakeSocket();

    hub.onOpen(sock);
    hub.onMessage(sock, hello("wrong-token-wrong-token"));

    expect(sock.closed?.code).toBe(4001);
    expect(hub.connected).toBe(false);
  });

  test("protocol mismatch → 4002", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = new FakeSocket();

    hub.onOpen(sock);
    hub.onMessage(sock, hello(TOKEN, 99));

    expect(sock.closed?.code).toBe(4002);
  });

  test("no hello within the timeout → closed 4001", async () => {
    const hub = new BridgeHub({ token: TOKEN, helloTimeoutMs: 10 });
    const sock = new FakeSocket();

    hub.onOpen(sock);
    await sleep(30);

    expect(sock.closed?.code).toBe(4001);
  });

  test("an unauthenticated socket's responses and pings are ignored", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = new FakeSocket();

    hub.onOpen(sock);
    hub.onMessage(sock, JSON.stringify({ type: "ping" }));

    expect(sock.sent).toEqual([]);
  });

  test("a second paired socket replaces the first with 4000", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const first = paired(hub);
    const second = paired(hub);

    expect(first.closed?.code).toBe(4000);
    expect(second.closed).toBeNull();
    expect(hub.connected).toBe(true);
  });
});

describe("BridgeHub requests", () => {
  test("not connected → disconnected failure, no throw", async () => {
    const hub = new BridgeHub({ token: TOKEN });

    expect(await hub.request("tabs.list", {}, 100)).toEqual({
      ok: false,
      error: {
        code: "disconnected",
        message: "Chrome extension not connected",
      },
    });
  });

  test("request/response round trip by id", async () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);
    const pending = hub.request("tabs.list", { a: 1 }, 1000);

    await sleep(0);
    const req = sock.last();

    expect(req).toMatchObject({
      type: "req",
      method: "tabs.list",
      params: { a: 1 },
    });
    hub.onMessage(
      sock,
      JSON.stringify({ type: "res", id: req.id, ok: true, result: [] })
    );

    expect(await pending).toEqual({ ok: true, result: [] });
  });

  test("error response carries the extension's code", async () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);
    const pending = hub.request("page.click", {}, 1000);

    await sleep(0);
    hub.onMessage(
      sock,
      JSON.stringify({
        type: "res",
        id: sock.last().id,
        ok: false,
        error: { code: "denied", message: "form control" },
      })
    );

    expect(await pending).toEqual({
      ok: false,
      error: { code: "denied", message: "form control" },
    });
  });

  test("timeout resolves a failure", async () => {
    const hub = new BridgeHub({ token: TOKEN });

    paired(hub);
    const res = await hub.request("tabs.list", {}, 10);

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe("timeout");
  });

  test("disconnect resolves pending requests as disconnected", async () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);
    const pending = hub.request("page.read", {}, 5000);

    await sleep(0);
    hub.onClose(sock);

    const res = await pending;

    expect(!res.ok && res.error.code).toBe("disconnected");
    expect(hub.connected).toBe(false);
  });

  test("requests are serialized: the second is sent only after the first answers", async () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);
    const first = hub.request("tabs.list", {}, 1000);
    const second = hub.request("page.read", {}, 1000);

    await sleep(0);
    const reqs = () => sock.sent.filter((f: any) => f.type === "req");

    expect(reqs()).toHaveLength(1);
    hub.onMessage(
      sock,
      JSON.stringify({ type: "res", id: sock.last().id, ok: true, result: 1 })
    );
    await first;
    await sleep(0);
    expect(reqs()).toHaveLength(2);
    hub.onMessage(
      sock,
      JSON.stringify({ type: "res", id: sock.last().id, ok: true, result: 2 })
    );
    expect(await second).toEqual({ ok: true, result: 2 });
  });

  test("ping from the paired socket gets a pong", () => {
    const hub = new BridgeHub({ token: TOKEN });
    const sock = paired(hub);

    hub.onMessage(sock, JSON.stringify({ type: "ping" }));

    expect(sock.last()).toEqual({ type: "pong" });
  });
});
