/** JSON-RPC 2.0 request (has an id; expects a response). */
export interface IJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC 2.0 notification (no id; fire-and-forget). */
export interface IJsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC 2.0 response (result xor error). */
export interface IJsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A tool advertised by an MCP server (one `tools/list` entry). */
export interface IMcpToolInfo {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: Record<string, unknown>;
}

/**
 * A connection to a single MCP server. The stdio implementation spawns a child
 * process; tests use an in-memory fake. Methods reject on protocol/transport
 * failure — the registry decides how to degrade so a dead server never breaks
 * the agent loop.
 */
export interface IMcpTransport {
  /** Open the connection and perform the MCP `initialize` handshake. */
  connect(): Promise<void>;

  /** List the server's tools (`tools/list`). */
  listTools(): Promise<IMcpToolInfo[]>;

  /** Call a tool (`tools/call`) and return its result rendered as text. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;

  /** Shut the connection down. */
  close(): Promise<void>;
}

/** Config for one MCP server, declared under `mcpServers` in tsforge.config.json. */
export interface IMcpServerConfig {
  /** Transport kind. `stdio` (default) spawns `command`; `http` POSTs to `url`. */
  readonly type?: "stdio" | "http";
  /** stdio: executable to spawn. */
  readonly command?: string;
  /** stdio: arguments for `command`. */
  readonly args?: readonly string[];
  /** stdio: extra environment variables (merged over the parent env). */
  readonly env?: Readonly<Record<string, string>>;
  /** http: server URL. */
  readonly url?: string;
  /** http: headers sent on every request (e.g. `Authorization: Bearer …`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-call timeout in milliseconds (default 30000). */
  readonly timeoutMs?: number;
}
