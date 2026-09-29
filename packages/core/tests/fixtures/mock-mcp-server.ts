// Minimal mock MCP server over stdio (newline-delimited JSON-RPC) for tests.
// Implements initialize / tools/list / tools/call(echo). Not shipped — test-only.
import { isRecord } from "../../src/lib/guards";

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function argText(params: unknown): string {
  if (isRecord(params) && isRecord(params.arguments)) {
    const msg = params.arguments.msg;

    if (typeof msg === "string") {
      return msg;
    }
  }

  return "";
}

function handle(message: unknown): void {
  // Chatty mode (opt-in via env): log every message to stderr the way
  // mcp-remote does, to prove the transport never lets it reach the terminal.
  if (process.env.MOCK_MCP_STDERR === "1" && isRecord(message)) {
    process.stderr.write(
      `[4242] [Local\u2192Remote] ${String(message.method)}\n`
    );
  }

  if (!isRecord(message) || typeof message.id !== "number") {
    return; // notification or junk — no response
  }

  const id = message.id;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "mock", version: "0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "echoes msg",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
            },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    // Crash mode (opt-in via env): exit WITHOUT responding to a call, to simulate
    // a server that dies mid-session. Exercises the transport's connection-closed
    // handling — the in-flight request must fail fast, not wait out its timeout.
    if (process.env.MOCK_MCP_CRASH_ON_CALL === "1") {
      process.stderr.write("fatal: \u001b[31mOAuth token expired\u001b[0m\n");
      process.exit(1);
    }

    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `echo: ${argText(message.params)}` }],
      },
    });
  } else {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "method not found" },
    });
  }
}

function parseLine(line: string): void {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return;
  }

  try {
    handle(JSON.parse(trimmed));
  } catch {
    // a malformed line from the test harness is ignored on purpose
    process.stderr.write("mock-mcp-server: skipped malformed line\n");
  }
}

const textDecoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += textDecoder.decode(chunk, { stream: true });

  let newline = buffer.indexOf("\n");

  while (newline !== -1) {
    parseLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
}
