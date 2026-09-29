import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StderrTail, drainStderr } from "../src/mcp/stderr-tail";
import { StdioMcpTransport } from "../src/mcp";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.ts");

/** Runs a transport inside a CHILD process against the chatty mock server and
 *  returns what the child itself wrote to its stderr — in real use, that is the
 *  terminal under the interactive UI. */
async function childStderr(
  traceFile: string
): Promise<{ stderr: string; stdout: string }> {
  const script = `
    import { StdioMcpTransport } from ${JSON.stringify(join(import.meta.dir, "..", "src", "mcp"))};
    const t = new StdioMcpTransport("chatty", {
      type: "stdio",
      command: process.execPath,
      args: [${JSON.stringify(SERVER)}],
      env: { MOCK_MCP_STDERR: "1" },
      timeoutMs: 5000,
    });
    await t.connect();
    await t.listTools();
    console.log(await t.callTool("echo", { msg: "hi" }));
    await t.close();
  `;
  const dir = mkdtempSync(join(tmpdir(), "mcp-stderr-"));
  const file = join(dir, "run.ts");

  await Bun.write(file, script);

  const proc = Bun.spawn([process.execPath, file], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TSFORGE_TRACE: traceFile },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr };
}

test("a chatty stdio MCP server's stderr never reaches the terminal; it goes to the trace", async () => {
  const trace = join(mkdtempSync(join(tmpdir(), "mcp-trace-")), "trace.log");
  const { stdout, stderr } = await childStderr(trace);

  expect(stdout.trim()).toBe("echo: hi");
  // the bug: mcp-remote's "[pid] [Local→Remote] tools/call" painted over the TUI
  expect(stderr).not.toContain("Local→Remote");
  expect(stderr).toBe("");

  const traced = readFileSync(trace, "utf8");

  expect(traced).toContain("[mcp:chatty] [4242] [Local→Remote] initialize");
  expect(traced).toContain("[mcp:chatty] [4242] [Local→Remote] tools/call");
}, 20_000);

test("a server that dies explains why: its last stderr lands in the error", async () => {
  const t = new StdioMcpTransport("mock", {
    type: "stdio",
    command: process.execPath,
    args: [SERVER],
    env: { MOCK_MCP_CRASH_ON_CALL: "1" },
    timeoutMs: 5000,
  });

  await t.connect();
  await expect(t.callTool("echo", { msg: "x" })).rejects.toThrow(
    "connection closed unexpectedly: fatal: OAuth token expired"
  );
  await t.close();
}, 20_000);

test("stderr that arrives just AFTER stdout closes still makes it into the error", async () => {
  // A shell server, because only a real fd close ends the stream early: answer
  // initialize (id 0), swallow the initialized notification, then on the call
  // CLOSE STDOUT FIRST and explain on stderr a moment later — the order a dying
  // bridge often uses.
  const script = [
    "read -r _",
    `printf '%s\\n' '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}'`,
    "read -r _",
    "read -r _",
    "exec 1>&-",
    "sleep 0.05",
    "echo 'fatal: upstream closed the session' >&2",
    "exit 1",
  ].join("\n");
  const t = new StdioMcpTransport("mock", {
    type: "stdio",
    command: "sh",
    args: ["-c", script],
    timeoutMs: 5000,
  });

  await t.connect();
  await expect(t.callTool("echo", { msg: "x" })).rejects.toThrow(
    "connection closed unexpectedly: fatal: upstream closed the session"
  );
  await t.close();
}, 20_000);

test("StderrTail: traces complete lines, strips colour, keeps the last 10", () => {
  const seen: string[] = [];
  const tail = new StderrTail("s", (scope, line) =>
    seen.push(`${scope} ${line}`)
  );

  tail.push("\u001b[33mwarn\u001b[0m: a\r\nb");
  expect(seen).toEqual(["mcp:s warn: a"]); // "b" is not complete yet
  tail.push("\n\n   \n");
  expect(seen).toEqual(["mcp:s warn: a", "mcp:s b"]); // blank lines dropped

  for (let i = 0; i < 12; i += 1) {
    tail.push(`line ${String(i)}\n`);
  }

  expect(tail.text().split(" | ")).toHaveLength(10);
  expect(tail.text()).toStartWith("line 2 | ");
  expect(tail.text()).toEndWith("line 11");
});

test("StderrTail: a trailing partial line is flushed on end, long lines capped", () => {
  const tail = new StderrTail("s", () => {});

  tail.push(`${"x".repeat(500)}\npartial`);
  tail.end();

  const [long, last] = tail.text().split(" | ");

  expect(long).toHaveLength(301);
  expect(long?.endsWith("…")).toBe(true);
  expect(last).toBe("partial");
});

test("drainStderr reads a stream to the end and flushes", async () => {
  const tail = new StderrTail("s", () => {});
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("one\ntw"));
      c.enqueue(enc.encode("o"));
      c.close();
    },
  });

  await drainStderr(stream, tail);
  expect(tail.text()).toBe("one | two");
});
