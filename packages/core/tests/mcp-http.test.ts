import { test, expect, afterEach } from "bun:test";
import {
  HttpMcpTransport,
  McpRegistry,
  connectMcpServers,
  parseMcpServers,
} from "../src/mcp";
import { findResponse, sseDataEvents } from "../src/mcp/http-transport";

/** What the fake server saw, per request. */
interface ISeen {
  method: string;
  rpc: string | undefined;
  headers: Record<string, string>;
}

interface IFakeOpts {
  /** Reply format for requests (notifications always get 202). */
  mode?: "json" | "sse" | "sse-open";
  /** Required `Authorization` header value; anything else → 401. */
  auth?: string;
  /** Session id issued on initialize. */
  session?: string;
  /** Protocol version the server answers initialize with. */
  version?: string;
  /** Forget the session after this many post-initialize requests (→ 404). */
  forgetAfter?: number;
  /** Delay every request reply by this many ms. */
  delayMs?: number;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

function rpcResult(method: string, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return { protocolVersion: "x", capabilities: {}, serverInfo: {} };
  }

  if (method === "tools/list") {
    return {
      tools: [
        { name: "echo", inputSchema: { type: "object" } },
        { name: "boom", inputSchema: { type: "object" } },
      ],
    };
  }

  const args = params.arguments;
  const msg =
    typeof args === "object" && args !== null && "msg" in args
      ? String(args.msg)
      : "";

  return params.name === "boom"
    ? { isError: true, content: [{ type: "text", text: "boom failed" }] }
    : { content: [{ type: "text", text: `echo: ${msg}` }] };
}

/** A Streamable HTTP MCP server with switchable behaviours. Returns its URL and
 *  the log of requests it received. */
function fakeServer(opts: IFakeOpts = {}): { url: string; seen: ISeen[] } {
  const seen: ISeen[] = [];
  let live = new Set<string>();
  let sinceInit = 0;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};

      req.headers.forEach((v, k) => {
        headers[k] = v;
      });

      if (req.method === "DELETE") {
        seen.push({ method: "DELETE", rpc: undefined, headers });

        return new Response(null, { status: 204 });
      }

      const body: unknown = await req.json();
      const rec =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const rpc = typeof rec.method === "string" ? rec.method : undefined;

      seen.push({ method: req.method, rpc, headers });

      if (opts.auth !== undefined && headers.authorization !== opts.auth) {
        return Response.json(
          { statusCode: 401, error: "UnauthorizedException" },
          { status: 401 }
        );
      }

      const isInit = rpc === "initialize";

      if (!isInit && opts.session !== undefined) {
        const sid = headers["mcp-session-id"];

        if (sid === undefined || !live.has(sid)) {
          return new Response("session not found", { status: 404 });
        }

        sinceInit += 1;

        if (opts.forgetAfter !== undefined && sinceInit > opts.forgetAfter) {
          live = new Set();
          sinceInit = 0;

          return new Response("session not found", { status: 404 });
        }
      }

      if (rec.id === undefined) {
        return new Response(null, { status: 202 });
      }

      if (opts.delayMs !== undefined) {
        await Bun.sleep(opts.delayMs);
      }

      const params =
        typeof rec.params === "object" && rec.params !== null
          ? (rec.params as Record<string, unknown>)
          : {};
      const result = rpcResult(rpc ?? "", params);
      const reply = {
        jsonrpc: "2.0",
        id: rec.id,
        result:
          isInit && opts.version !== undefined
            ? { ...(result as object), protocolVersion: opts.version }
            : result,
      };
      const out = new Headers();

      if (isInit && opts.session !== undefined) {
        const sid = `${opts.session}-${String(Date.now())}-${String(Math.random())}`;

        live.add(sid);
        sinceInit = 0;
        out.set("Mcp-Session-Id", sid);
      }

      const mode = opts.mode ?? "json";

      if (mode === "json") {
        out.set("Content-Type", "application/json");

        return new Response(JSON.stringify(reply), { headers: out });
      }

      out.set("Content-Type", "text/event-stream");

      // A progress notification first, then the response split across chunks.
      const note = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`;
      const text = `event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`;
      const half = Math.floor(text.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const enc = new TextEncoder();

          ctrl.enqueue(enc.encode(`: keepalive\n\n${note}`));
          ctrl.enqueue(enc.encode(text.slice(0, half)));
          ctrl.enqueue(enc.encode(text.slice(half)));

          if (mode === "sse") {
            ctrl.close();
          }
          // "sse-open": never close — the client must stop on its own.
        },
      });

      return new Response(stream, { headers: out });
    },
  });

  return { url: `http://localhost:${String(server.port)}/mcp`, seen };
}

function transport(
  url: string,
  extra: { headers?: Record<string, string>; timeoutMs?: number } = {}
): HttpMcpTransport {
  return new HttpMcpTransport("fake", {
    type: "http",
    url,
    timeoutMs: extra.timeoutMs ?? 3000,
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
  });
}

for (const mode of ["json", "sse", "sse-open"] as const) {
  test(`http transport (${mode}): connect, list, call`, async () => {
    const { url } = fakeServer({ mode });
    const t = transport(url);

    await t.connect();
    expect((await t.listTools()).map((x) => x.name)).toEqual(["echo", "boom"]);
    expect(await t.callTool("echo", { msg: "hi" })).toBe("echo: hi");
    await t.close();
  });
}

test("sends configured headers on every request, including the handshake", async () => {
  const { url, seen } = fakeServer({ auth: "Bearer k1" });
  const t = transport(url, { headers: { Authorization: "Bearer k1" } });

  await t.connect();
  await t.callTool("echo", { msg: "x" });

  expect(seen.map((s) => s.rpc)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  expect(seen.every((s) => s.headers.authorization === "Bearer k1")).toBe(true);
  expect(seen[0]?.headers.accept).toContain("text/event-stream");
});

test("a wrong key fails connect with a plain 401 reason", async () => {
  const { url } = fakeServer({ auth: "Bearer right" });
  const t = transport(url, { headers: { Authorization: "Bearer wrong" } });

  await expect(t.connect()).rejects.toThrow(/HTTP 401 \(unauthorized/);
});

test("echoes the session id and negotiated protocol version after initialize", async () => {
  const { url, seen } = fakeServer({ session: "s", version: "2025-03-26" });
  const t = transport(url);

  await t.connect();
  await t.listTools();

  const init = seen[0];
  const list = seen.find((s) => s.rpc === "tools/list");

  expect(init?.headers["mcp-session-id"]).toBeUndefined();
  expect(list?.headers["mcp-session-id"]).toMatch(/^s-/);
  expect(list?.headers["mcp-protocol-version"]).toBe("2025-03-26");
});

test("re-initializes once when the server forgets the session (404)", async () => {
  const { url, seen } = fakeServer({ session: "s", forgetAfter: 2 });
  const t = transport(url);

  await t.connect(); // 1: notifications/initialized
  await t.listTools(); // 2
  // 3 → 404, then a fresh initialize + retry succeed
  expect(await t.callTool("echo", { msg: "again" })).toBe("echo: again");
  expect(seen.filter((s) => s.rpc === "initialize")).toHaveLength(2);
});

test("an isError tool result throws its text (not reported as success)", async () => {
  const { url } = fakeServer();
  const t = transport(url);

  await t.connect();
  await expect(t.callTool("boom", {})).rejects.toThrow("boom failed");
});

test("a slow server times out with a clear message", async () => {
  const { url } = fakeServer({ delayMs: 1500 });
  const t = transport(url, { timeoutMs: 200 });

  await expect(t.connect()).rejects.toThrow(/timed out after 200ms/);
});

test("close sends DELETE for the session and fails later calls fast", async () => {
  const { url, seen } = fakeServer({ session: "s" });
  const t = transport(url);

  await t.connect();
  await t.close();

  expect(seen.at(-1)?.method).toBe("DELETE");
  expect(seen.at(-1)?.headers["mcp-session-id"]).toMatch(/^s-/);
  await expect(t.listTools()).rejects.toThrow(/closed/);
});

test("registry + connectMcpServers wire an http server end to end", async () => {
  const { url } = fakeServer({ mode: "sse", auth: "Bearer k", session: "s" });
  const servers = parseMcpServers(
    {
      twenty: {
        type: "http",
        url,
        headers: { Authorization: "Bearer ${TEST_KEY}" },
      },
    },
    { TEST_KEY: "k" }
  );
  const lines: string[] = [];
  const reg = await connectMcpServers(servers, (m) => lines.push(m));

  expect(lines).toEqual(["MCP server 'twenty': 2 tool(s) registered"]);
  expect(reg).toBeInstanceOf(McpRegistry);
  expect(await reg?.callTool("mcp__twenty__echo", { msg: "ok" })).toBe(
    "echo: ok"
  );
  await reg?.closeAll();
});

test("parseMcpServers keeps http headers with ${VAR} interpolation", () => {
  const s = parseMcpServers(
    { t: { type: "http", url: "http://x", headers: { A: "Bearer ${K}" } } },
    { K: "v" }
  );

  expect(s.t?.headers).toEqual({ A: "Bearer v" });
});

test("sseDataEvents: CRLF, multi-line data, comments, other fields", () => {
  const body =
    ': ping\r\n\r\nevent: message\r\nid: 1\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: x\n\n';

  expect(sseDataEvents(body)).toEqual(['{"a":\n1}', "x"]);
});

test("findResponse: single, batch, and ignores notifications / other ids", () => {
  const r = { jsonrpc: "2.0", id: 3, result: 1 };

  expect(findResponse([{ jsonrpc: "2.0", method: "n" }, r], 3)).toBe(r);
  expect(findResponse([[{ id: 2, result: 0 }, r]], 3)).toBe(r);
  expect(
    findResponse([{ id: 3, method: "server-request" }], 3)
  ).toBeUndefined();
});
