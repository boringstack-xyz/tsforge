import type { IMcpServerConfig, IMcpTransport } from "./mcp.types";
import { McpRegistry } from "./registry";
import { HttpMcpTransport } from "./http-transport";
import { StdioMcpTransport } from "./stdio-transport";

/** Hard cap on connecting + listing tools for ONE server, independent of that
 *  server's own per-request `timeoutMs` (which only bounds a single JSON-RPC
 *  call once connected). A remote server that cold-starts slowly (e.g. `npx
 *  mcp-remote` resolving the package, or a stalled OAuth handshake) must never
 *  hold up every session that has it configured — global `mcpServers` in
 *  `~/.tsforge/models.json` means this runs on EVERY session, not just an
 *  opted-in project, so the old effectively-unbounded wait (up to the 30s
 *  per-request default, potentially longer on a hanging handshake) is no
 *  longer acceptable. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Race `addServer` against a timeout so a slow/hanging server can't stall
 *  startup. On timeout, closes the transport (kills the spawned process and
 *  fails any request still in flight) BEFORE rejecting — otherwise the losing
 *  `addServer` call keeps running in the background and can register tools
 *  into `registry` moments after we've already reported the server as failed,
 *  and its subprocess would leak (orphaned `npx`/node process). */
async function addServerWithTimeout(
  registry: McpRegistry,
  name: string,
  transport: IMcpTransport
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((_resolve, reject) => {
    timer = setTimeout(() => {
      void transport.close();
      reject(
        new Error(`connect timed out after ${String(CONNECT_TIMEOUT_MS)}ms`)
      );
    }, CONNECT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([registry.addServer(name, transport), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connect every configured MCP server and return a registry, or null if none are
 * configured or none connected. Servers connect IN PARALLEL, each bounded by
 * `CONNECT_TIMEOUT_MS` — per-server failures (including a timeout) are reported
 * and skipped so one bad or slow server can never block the run or the others.
 * `type: "http"` entries use Streamable HTTP; everything else spawns over stdio.
 */
export async function connectMcpServers(
  servers: Readonly<Record<string, IMcpServerConfig>>,
  report: (message: string) => void
): Promise<McpRegistry | null> {
  const names = Object.keys(servers);

  if (names.length === 0) {
    return null;
  }

  const registry = new McpRegistry();

  await Promise.all(
    names.map(async (name) => {
      const config = servers[name];

      if (config === undefined) {
        return;
      }

      try {
        const count = await addServerWithTimeout(
          registry,
          name,
          config.type === "http"
            ? new HttpMcpTransport(name, config)
            : new StdioMcpTransport(name, config)
        );

        report(`MCP server '${name}': ${count} tool(s) registered`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        report(`MCP server '${name}' failed to connect: ${message}`);
      }
    })
  );

  return registry.size > 0 ? registry : null;
}
