import { test, expect, describe, spyOn } from "bun:test";
import {
  LineDecoder,
  encodeMessage,
  McpRegistry,
  parseMcpServers,
  interpolateEnv,
  diagnoseMcpServers,
  warnMcpConfigIssues,
  setMcpDiagnosticSink,
  mcpToolName,
  mapMcpTool,
  type IMcpToolInfo,
  type IMcpTransport,
} from "../src/mcp";
import { errorText } from "../src/mcp/jsonrpc";

class FakeTransport implements IMcpTransport {
  connected = false;
  closed = false;

  constructor(
    private readonly tools: IMcpToolInfo[],
    private readonly behavior?: (
      name: string,
      args: Record<string, unknown>
    ) => Promise<string>
  ) {}

  connect(): Promise<void> {
    this.connected = true;

    return Promise.resolve();
  }

  listTools(): Promise<IMcpToolInfo[]> {
    return Promise.resolve(this.tools);
  }

  callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.behavior !== undefined) {
      return this.behavior(name, args);
    }

    return Promise.resolve(`called ${name} with ${JSON.stringify(args)}`);
  }

  close(): Promise<void> {
    this.closed = true;

    return Promise.resolve();
  }
}

const ECHO_TOOL: IMcpToolInfo = {
  name: "echo",
  description: "echoes input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("mcp: jsonrpc framing", () => {
  test("encodeMessage appends a newline", () => {
    expect(encodeMessage({ a: 1 })).toBe('{"a":1}\n');
  });

  test("LineDecoder reassembles a split message", () => {
    const d = new LineDecoder();

    expect(d.push('{"x":')).toEqual([]);
    expect(d.push("1}\n")).toEqual([{ x: 1 }]);
  });

  test("LineDecoder yields multiple messages in one chunk", () => {
    const d = new LineDecoder();

    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("LineDecoder skips malformed and blank lines", () => {
    const d = new LineDecoder();

    expect(d.push('not json\n\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  test("errorText: a present error member is never null (no message ⇒ generic)", () => {
    // A well-formed error message passes through verbatim.
    expect(
      errorText({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "bad" },
      })
    ).toBe("bad");

    // A malformed error (error member present, no string message) must STILL be
    // an error — else the transport resolves message.result to `undefined`, which
    // the model reads as a successful empty result (lost error signal).
    expect(
      errorText({ jsonrpc: "2.0", id: 1, error: { code: -32600 } })
    ).not.toBe(null);
    // a bare string error is surfaced verbatim (more actionable than the generic)
    expect(errorText({ jsonrpc: "2.0", id: 1, error: "boom" })).toBe("boom");

    // No error member ⇒ a real success ⇒ null (so the caller resolves the result).
    expect(errorText({ jsonrpc: "2.0", id: 1, result: { ok: true } })).toBe(
      null
    );
    expect(errorText("not an object")).toBe(null);
  });
});

describe("mcp: schema mapping", () => {
  test("mcpToolName namespaces and sanitizes", () => {
    expect(mcpToolName("my server", "do.thing")).toBe(
      "mcp__my_server__do_thing"
    );
  });

  test("mapMcpTool produces an OpenAI function schema", () => {
    const schema = mapMcpTool("ctx7", ECHO_TOOL);

    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("mcp__ctx7__echo");
    expect(schema.function.description).toBe("echoes input");
    expect(schema.function.parameters).toEqual(ECHO_TOOL.inputSchema);
  });

  test("mapMcpTool fills an empty schema and default description", () => {
    const schema = mapMcpTool("s", { name: "ping", inputSchema: {} });

    expect(schema.function.description).toBe("s: ping");
    expect(schema.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("mcp: config parsing", () => {
  test("interpolateEnv substitutes and blanks missing vars", () => {
    expect(interpolateEnv("a-${TOK}-b", { TOK: "X" })).toBe("a-X-b");
    expect(interpolateEnv("a-${MISSING}-b", {})).toBe("a--b");
  });

  test("parseMcpServers accepts a valid stdio entry with interpolation", () => {
    const servers = parseMcpServers(
      {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: { CONTEXT7_API_KEY: "${KEY}" },
        },
      },
      { KEY: "secret" }
    );

    expect(servers.context7?.type).toBe("stdio");
    expect(servers.context7?.command).toBe("npx");
    expect(servers.context7?.env?.CONTEXT7_API_KEY).toBe("secret");
  });

  test("parseMcpServers drops a stdio entry with no command", () => {
    const servers = parseMcpServers({ bad: { args: ["x"] } }, {});

    expect(servers.bad).toBeUndefined();
  });

  test("parseMcpServers requires url for http", () => {
    const ok = parseMcpServers({ s: { type: "http", url: "http://x" } }, {});
    const bad = parseMcpServers({ s: { type: "http" } }, {});

    expect(ok.s?.type).toBe("http");
    expect(bad.s).toBeUndefined();
  });

  test("diagnoseMcpServers flags empty env interpolation and misnamed integration keys", () => {
    const raw = {
      "linear-mcp": { command: "linear", env: { TOKEN: "${MISSING}" } },
      ctx7: { command: "npx", args: ["-y", "mcp"] },
    };
    const parsed = parseMcpServers(raw, {});

    const warnings = diagnoseMcpServers(raw, parsed, {});

    expect(warnings.some((w) => w.includes("linear-mcp"))).toBe(true);
    expect(warnings.some((w) => w.includes("MISSING"))).toBe(true);
    expect(warnings.some((w) => w.includes("no integration keys"))).toBe(true);
  });

  test("config diagnostics go to an installed sink instead of stderr", () => {
    // The REPL points this at its boot buffer: on a TTY these fire during config
    // load, before the pane console paints, and its first paint would wipe them.
    const raw = { "linear-mcp": { command: "linear" } };
    const parsed = parseMcpServers(raw, {});
    const captured: string[] = [];

    setMcpDiagnosticSink((text) => captured.push(text));

    try {
      warnMcpConfigIssues(raw, parsed, {});
    } finally {
      setMcpDiagnosticSink(null);
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.join("")).toContain("linear-mcp");
  });

  test("clearing the sink restores stderr", () => {
    const raw = { "linear-mcp": { command: "linear" } };
    const parsed = parseMcpServers(raw, {});
    const captured: string[] = [];
    const chunks: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));

        return true;
      }
    );

    setMcpDiagnosticSink((text) => captured.push(text));
    setMcpDiagnosticSink(null);

    try {
      warnMcpConfigIssues(raw, parsed, {});
    } finally {
      spy.mockRestore();
    }

    expect(captured).toEqual([]);
    expect(chunks.join("")).toContain("linear-mcp");
  });
});

describe("mcp: registry", () => {
  test("addServer registers namespaced tools and schemas", async () => {
    const registry = new McpRegistry();
    const count = await registry.addServer(
      "ctx7",
      new FakeTransport([ECHO_TOOL])
    );

    expect(count).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.has("mcp__ctx7__echo")).toBe(true);
    expect(registry.toolSchemas()[0]?.function.name).toBe("mcp__ctx7__echo");
  });

  test("callTool routes to the owning transport", async () => {
    const registry = new McpRegistry();

    await registry.addServer(
      "ctx7",
      new FakeTransport([ECHO_TOOL], (_n, a) =>
        Promise.resolve(`echo:${JSON.stringify(a)}`)
      )
    );

    const out = await registry.callTool("mcp__ctx7__echo", { msg: "hi" });

    expect(out).toBe('echo:{"msg":"hi"}');
  });

  test("callTool on an unknown tool returns text, not a throw", async () => {
    const registry = new McpRegistry();

    expect(await registry.callTool("mcp__x__nope", {})).toContain(
      "unknown MCP tool"
    );
  });

  test("callTool returns failure text when the transport throws", async () => {
    const registry = new McpRegistry();

    await registry.addServer(
      "ctx7",
      new FakeTransport([ECHO_TOOL], () =>
        Promise.reject(new Error("server died"))
      )
    );

    const out = await registry.callTool("mcp__ctx7__echo", {});

    expect(out).toContain("failed");
    expect(out).toContain("server died");
  });

  test("dedupes identical tool names within one server", async () => {
    const registry = new McpRegistry();
    const count = await registry.addServer(
      "s",
      new FakeTransport([ECHO_TOOL, ECHO_TOOL])
    );

    expect(count).toBe(1);
  });

  test("serverNames() returns the SANITIZED identity (matches the wire tool name)", async () => {
    // A server whose config name has a `.` is advertised as `mcp__my_server__…`
    // and the policy classifier parses `my_server` back out. serverNames() must
    // return that same sanitized identity, or the registered-server check denies
    // every tool from the server as "unregistered".
    const registry = new McpRegistry();

    await registry.addServer("my.server", new FakeTransport([ECHO_TOOL]));

    expect(registry.toolSchemas()[0]?.function.name).toBe(
      "mcp__my_server__echo"
    );
    expect(registry.serverNames()).toEqual(["my_server"]);
  });

  test("callTool caps an oversized result from an untrusted server", async () => {
    const registry = new McpRegistry();

    await registry.addServer(
      "big",
      new FakeTransport([ECHO_TOOL], () => Promise.resolve("x".repeat(200_000)))
    );

    const out = await registry.callTool("mcp__big__echo", {});

    expect(out.length).toBeLessThan(200_000);
    expect(out).toContain("MCP result truncated");
  });

  test("closeAll closes every transport", async () => {
    const registry = new McpRegistry();
    const transport = new FakeTransport([ECHO_TOOL]);

    await registry.addServer("s", transport);
    await registry.closeAll();

    expect(transport.closed).toBe(true);
  });
});
