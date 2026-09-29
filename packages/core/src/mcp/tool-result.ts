import { isRecord } from "../lib/guards";
import type { IMcpToolInfo } from "./mcp.types";

/** Result shaping shared by every MCP transport (stdio, http): the protocol
 *  constants, `tools/list` → typed tool info, and `tools/call` → plain text. */

export const PROTOCOL_VERSION = "2024-11-05";
export const DEFAULT_TIMEOUT_MS = 30000;

/** Render an MCP `tools/list` result into typed tool info, dropping bad entries. */
export function extractTools(result: unknown): IMcpToolInfo[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    return [];
  }

  const tools: IMcpToolInfo[] = [];

  for (const entry of result.tools) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }

    tools.push({
      name: entry.name,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : {},
    });
  }

  return tools;
}

/** Render an MCP `tools/call` result's content array into plain text. */
export function extractText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }

  const parts: string[] = [];

  for (const item of result.content) {
    if (isRecord(item) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.length > 0 ? parts.join("\n") : JSON.stringify(result);
}

/** A `tools/call` result as text. MCP application errors arrive as isError:true on
 *  a successful JSON-RPC result; treating them as ok text made retain() report
 *  success on permission denials, so they throw instead. */
export function toolCallText(result: unknown): string {
  if (isRecord(result) && result.isError === true) {
    throw new Error(extractText(result));
  }

  return extractText(result);
}
