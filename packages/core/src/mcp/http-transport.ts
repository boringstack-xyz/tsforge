import { isRecord } from "../lib/guards";
import { errorText } from "./jsonrpc";
import type {
  IMcpServerConfig,
  IMcpToolInfo,
  IMcpTransport,
} from "./mcp.types";
import { DEFAULT_TIMEOUT_MS, extractTools, toolCallText } from "./tool-result";

/** Streamable HTTP arrived in this protocol revision; the server may answer with
 *  an older one, which is then echoed back on every later request. */
const HTTP_PROTOCOL_VERSION = "2025-06-18";

/** Cap on an error body quoted back to the model — a server's HTML error page
 *  must not flood the context. */
const MAX_ERROR_BODY_CHARS = 300;

/** The data payloads of every complete event in a Server-Sent Events body.
 *  Multi-line `data:` fields join with "\n"; comments and other fields are
 *  ignored. */
export function sseDataEvents(body: string): string[] {
  const events: string[] = [];

  for (const block of body.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));

    if (data.length > 0) {
      events.push(data.join("\n"));
    }
  }

  return events;
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return undefined;
  }
}

/** The JSON-RPC response carrying `id` among the messages of a reply — a single
 *  object, a batch array, or SSE events each holding one (or a batch). */
export function findResponse(
  messages: readonly unknown[],
  id: number
): Record<string, unknown> | undefined {
  for (const message of messages) {
    const candidates = Array.isArray(message) ? message : [message];

    for (const c of candidates) {
      if (isRecord(c) && c.id === id && ("result" in c || "error" in c)) {
        return c;
      }
    }
  }

  return undefined;
}

/** Read an SSE body into JSON-RPC messages, stopping early (and cancelling the
 *  stream) once the response to `awaitId` has arrived. */
async function readSse(
  stream: ReadableStream<Uint8Array>,
  awaitId: number | undefined
): Promise<unknown[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    buffer += done ? "\n\n" : decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n?/g, "\n");

    const cut = buffer.lastIndexOf("\n\n");

    if (cut !== -1) {
      for (const data of sseDataEvents(buffer.slice(0, cut + 2))) {
        const parsed = parseJson(data);

        if (parsed !== undefined) {
          messages.push(parsed);
        }
      }

      buffer = buffer.slice(cut + 2);
    }

    if (
      awaitId !== undefined &&
      findResponse(messages, awaitId) !== undefined
    ) {
      await reader.cancel().catch(() => undefined);

      return messages;
    }

    if (done) {
      return messages;
    }
  }
}

/** Plain-language reason for a failed HTTP status, so the model (and the user
 *  reading its reply) knows what to fix. */
function statusReason(status: number): string {
  if (status === 401 || status === 403) {
    return "unauthorized — check the Authorization header for this server in mcpServers";
  }

  if (status === 404) {
    return "not found — check the server url";
  }

  return "server error";
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * MCP over Streamable HTTP: every JSON-RPC message is a POST to `url`, answered
 * with either a JSON body or an SSE stream. Sends the configured `headers` (e.g.
 * `Authorization: Bearer …`) on every request, carries the server's
 * `Mcp-Session-Id` once issued, re-initializes once if the server forgets that
 * session (404), and bounds each call by `timeoutMs`.
 */
export class HttpMcpTransport implements IMcpTransport {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 0;
  private closed = false;
  private readonly inFlight = new Set<AbortController>();
  private readonly timeoutMs: number;

  constructor(
    private readonly name: string,
    private readonly config: IMcpServerConfig
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.config.url === undefined || this.config.url.length === 0) {
      throw new Error(`MCP server '${this.name}' has no url`);
    }

    this.closed = false;
    await this.initialize();
  }

  async listTools(): Promise<IMcpToolInfo[]> {
    return extractTools(await this.request("tools/list", {}));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    return toolCallText(
      await this.request("tools/call", { name, arguments: args })
    );
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const ctrl of this.inFlight) {
      ctrl.abort();
    }

    this.inFlight.clear();

    const url = this.config.url;
    const session = this.sessionId;
    const headers = this.headers();

    this.sessionId = undefined;

    if (url === undefined || session === undefined) {
      return;
    }

    // Best effort: tell the server the session is over. A server that does not
    // support DELETE answers 405, which is fine.
    try {
      await fetch(url, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // the server may already be gone
    }
  }

  private async initialize(): Promise<void> {
    this.sessionId = undefined;
    this.protocolVersion = undefined;

    const result = await this.send("initialize", {
      protocolVersion: HTTP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tsforge", version: "0" },
    });

    this.protocolVersion =
      isRecord(result) && typeof result.protocolVersion === "string"
        ? result.protocolVersion
        : HTTP_PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** A request after connect. If the server dropped our session (404 while we
   *  hold one), start a fresh session and retry once. */
  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error(`MCP server '${this.name}' transport closed`);
    }

    const hadSession = this.sessionId !== undefined;

    try {
      return await this.send(method, params);
    } catch (err) {
      if (
        !(err instanceof HttpStatusError) ||
        err.status !== 404 ||
        !hadSession
      ) {
        throw err;
      }

      await this.initialize();

      return this.send(method, params);
    }
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;

    this.nextId += 1;

    const messages = await this.post(
      { jsonrpc: "2.0", id, method, params },
      id
    );
    const response = findResponse(messages, id);

    if (response === undefined) {
      throw new Error(
        `MCP server '${this.name}' sent no response to '${method}'`
      );
    }

    const err = errorText(response);

    if (err !== null) {
      throw new Error(err);
    }

    return response.result;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.config.headers ?? {}) };

    if (this.sessionId !== undefined) {
      h["Mcp-Session-Id"] = this.sessionId;
    }

    if (this.protocolVersion !== undefined) {
      h["MCP-Protocol-Version"] = this.protocolVersion;
    }

    return h;
  }

  /** POST one message; return the JSON-RPC messages in the reply (empty for a
   *  202 Accepted). With `awaitId`, an SSE reply is read only until the response
   *  to that id arrives — a server that keeps the stream open cannot stall the
   *  call. Throws on transport failure, timeout or a non-2xx status. */
  private async post(message: unknown, awaitId?: number): Promise<unknown[]> {
    const url = this.config.url ?? "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);

    this.inFlight.add(ctrl);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
        signal: ctrl.signal,
      });
      const session = res.headers.get("mcp-session-id");

      if (session !== null && session.length > 0) {
        this.sessionId = session;
      }

      const type = res.headers.get("content-type") ?? "";

      if (res.ok && type.includes("text/event-stream") && res.body !== null) {
        return await readSse(res.body, awaitId);
      }

      const body = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          `MCP server '${this.name}' returned HTTP ${String(res.status)} (${statusReason(res.status)}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}`
        );
      }

      if (body.trim().length === 0) {
        return [];
      }

      const parsed = parseJson(body);

      return parsed === undefined ? [] : [parsed];
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new Error(
          this.closed
            ? `MCP server '${this.name}' transport closed`
            : `MCP request to '${this.name}' timed out after ${String(this.timeoutMs)}ms`,
          { cause: err }
        );
      }

      throw err;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(ctrl);
    }
  }
}
