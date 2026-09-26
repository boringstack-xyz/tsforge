import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserBridge } from "../src/chrome-bridge/bridge-server";
import { PROTOCOL_VERSION } from "../src/chrome-bridge/chrome-bridge.constants";
import { loadOrCreateBridgeToken } from "../src/chrome-bridge/bridge-token";
import type { IBrowserBridge } from "../src/chrome-bridge/chrome-bridge.types";

const EXT = "fjlgfemoomkhjnjdcajjgkcdpmjkgedi";
const TOKEN = "server-test-token-0123456789";

let bridges: IBrowserBridge[] = [];

afterEach(() => {
  for (const b of bridges) {
    b.stop();
  }

  bridges = [];
});

function start(port = 0): IBrowserBridge {
  const b = startBrowserBridge({ port, token: TOKEN });

  bridges.push(b);

  return b;
}

function connect(
  port: number,
  origin: string
): Promise<{ ws: WebSocket; opened: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Origin: origin },
    } as any);

    ws.onopen = () => resolve({ ws, opened: true });
    ws.onerror = () => resolve({ ws, opened: false });
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
  });
}

describe("startBrowserBridge", () => {
  test("our extension origin + token pairs, then a request round-trips", async () => {
    const bridge = start();

    expect(bridge.status()).toBe("listening");

    const { ws, opened } = await connect(
      bridge.port,
      `chrome-extension://${EXT}`
    );

    expect(opened).toBe(true);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token: TOKEN,
        extVersion: "t",
      })
    );
    expect(await nextMessage(ws)).toEqual({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
    });
    expect(bridge.status()).toBe("connected");

    const reqSeen = nextMessage(ws);
    const pending = bridge.request("tabs.list", {});
    const req = await reqSeen;

    ws.send(
      JSON.stringify({ type: "res", id: req.id, ok: true, result: ["ok"] })
    );
    expect(await pending).toEqual({ ok: true, result: ["ok"] });
    ws.close();
  });

  test("a web-page origin cannot upgrade", async () => {
    const bridge = start();
    const { opened } = await connect(bridge.port, "https://evil.example");

    expect(opened).toBe(false);
    expect(bridge.status()).toBe("listening");
  });

  test("plain HTTP to the port is forbidden", async () => {
    const bridge = start();
    const res = await fetch(`http://127.0.0.1:${bridge.port}/bridge`);

    expect(res.status).toBe(403);
  });

  test("a second bridge on a taken port reports in-use and never throws", async () => {
    const first = start();
    const second = start(first.port);

    expect(second.status()).toBe("in-use");
    const res = await second.request("tabs.list", {});

    expect(res.ok).toBe(false);
  });
});

describe("loadOrCreateBridgeToken", () => {
  test("creates a 0600 token once and reuses it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsf-token-"));
    const path = join(dir, ".tsforge", "browser-token");
    const a = await loadOrCreateBridgeToken(path);
    const b = await loadOrCreateBridgeToken(path);

    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect((await readFile(path, "utf8")).trim()).toBe(a);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
