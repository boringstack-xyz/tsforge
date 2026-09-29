import { isRecord } from "../lib/guards";
import { LineDecoder, encodeMessage, errorText } from "./jsonrpc";
import {
  extractTools,
  toolCallText,
  DEFAULT_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "./tool-result";
import { StderrTail, drainStderr } from "./stderr-tail";
import type {
  IMcpServerConfig,
  IMcpToolInfo,
  IMcpTransport,
} from "./mcp.types";

interface IPending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * MCP transport over a child process's stdio, framed as newline-delimited
 * JSON-RPC. Performs the `initialize` handshake on connect, multiplexes requests
 * by id, and enforces a per-call timeout so a hung server cannot stall the loop.
 */
export class StdioMcpTransport implements IMcpTransport {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  /** The server's stderr — captured, never inherited (see StderrTail). */
  private readonly stderr: StderrTail;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, IPending>();
  private readonly timeoutMs: number;
  private nextId = 0;
  /** Set once the server's stdout closes (clean exit or crash) — so a request
   *  issued AFTER the connection died fails fast instead of waiting out its
   *  timeout. The readLoop's end is the single source of truth for "gone". */
  private connectionClosed = false;

  constructor(
    private readonly name: string,
    private readonly config: IMcpServerConfig
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.stderr = new StderrTail(name);
  }

  async connect(): Promise<void> {
    if (this.config.command === undefined) {
      throw new Error(`MCP server '${this.name}' has no command`);
    }

    const proc = Bun.spawn({
      cmd: [this.config.command, ...(this.config.args ?? [])],
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      // Piped and drained, never inherited: an inherited stderr paints the
      // server's own logging over the interactive UI.
      stderr: "pipe",
    });

    this.proc = proc;

    const stderrDone = drainStderr(proc.stderr, this.stderr);

    // Fire-and-forget, but NOT swallowed: when the read loop ends — stdout closed
    // on a clean exit, or a read error on a crash — fail every in-flight request
    // immediately with a clear "connection closed", rather than letting each one
    // wait out its 30s timeout and surface a misleading "timed out".
    void this.readLoop(proc.stdout)
      .catch(() => undefined)
      .then(async () => {
        // A dying server's last stderr lines can land just after stdout closes;
        // give them a moment so the error can say why.
        await Promise.race([stderrDone, Bun.sleep(100)]);
      })
      .finally(() => {
        this.connectionClosed = true;

        const why = this.stderr.text();

        this.failAllPending(
          `MCP server '${this.name}' connection closed unexpectedly${why.length > 0 ? `: ${why}` : ""}`
        );
      });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tsforge", version: "0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<IMcpToolInfo[]> {
    return extractTools(await this.request("tools/list", {}));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    return toolCallText(
      await this.request("tools/call", { name, arguments: args })
    );
  }

  close(): Promise<void> {
    this.connectionClosed = true;
    this.failAllPending("transport closed");
    this.proc?.kill();
    this.proc = null;

    return Promise.resolve();
  }

  /** Reject every in-flight request and clear the table — used both on an explicit
   *  close and when the read loop ends (the server went away). Idempotent: an empty
   *  table is a no-op, so a clean close before the loop's finally fires is harmless. */
  private failAllPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }

    this.pending.clear();
  }

  private async readLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const textDecoder = new TextDecoder();
    let done = false;

    while (!done) {
      const result = await reader.read();

      done = result.done;

      if (result.value !== undefined) {
        const text = textDecoder.decode(result.value, { stream: true });

        for (const message of this.decoder.push(text)) {
          this.handleMessage(message);
        }
      }
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    const err = errorText(message);

    if (err !== null) {
      pending.reject(new Error(err));

      return;
    }

    pending.resolve(message.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;

    if (proc === null) {
      return Promise.reject(new Error("transport not connected"));
    }

    // The connection already died — fail now, don't register a pending that would
    // only ever resolve via its timeout (the readLoop has already ended, so nothing
    // will fail it later). This also closes the race where the server exits between
    // connect() and a later call.
    if (this.connectionClosed) {
      return Promise.reject(
        new Error(`MCP server '${this.name}' connection closed`)
      );
    }

    const id = this.nextId;

    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request '${method}' timed out after ${this.timeoutMs}ms`
          )
        );
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      void proc.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id, method, params })
      );
      void proc.stdin.flush();
    });
  }

  private notify(method: string, params: unknown): void {
    const proc = this.proc;

    if (proc === null) {
      return;
    }

    void proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
    void proc.stdin.flush();
  }
}
