import { isRecord } from "../lib/guards";
import type { ActionKind } from "./policy.types";

/**
 * The MCP servers tsforge treats as tracker integrations (Linear, Notion,
 * Sentry, Twenty). Their FULL toolsets are offered to the model, so a raw call
 * like `mcp__linear__save_project` is classified by what it does — a read
 * (plan-safe) or a write (consent-gated) — exactly like the curated verbs,
 * instead of the generic `mcp_tool` kind that plan mode denies outright.
 */
export const INTEGRATION_MCP_SERVERS = [
  "linear",
  "notion",
  "sentry",
  "twenty",
] as const;

/** Widened once so `.includes(someString)` type-checks without a cast. */
const SERVER_NAMES: readonly string[] = INTEGRATION_MCP_SERVERS;

/** Tool names that only look things up. Anything else is treated as a write:
 *  an unrecognised verb must never be waved through as read-only. */
const READ_NAME =
  /^(?:get|list|search|find|fetch|query|read|retrieve|extract|lookup|whoami|learn|load|group[-_]by)(?:[-_]|$)|^(?:search|fetch)$/u;

/** Twenty's meta tools that only browse its catalog / docs. */
const TWENTY_BROWSE = new Set([
  "get_tool_catalog",
  "learn_tools",
  "list_object_metadata_names",
  "list_skills",
  "load_skills",
  "search_help_center",
]);

function isReadName(name: string): boolean {
  return READ_NAME.test(name.replace(/^notion-/u, ""));
}

/** integration_read / integration_write for a call to an integration server's
 *  raw tool, or null when `server` is not one (a plain `mcp_tool`). */
export function integrationMcpKind(
  server: string,
  tool: string,
  args: Record<string, unknown>
): ActionKind | null {
  if (!SERVER_NAMES.includes(server)) {
    return null;
  }

  if (server === "twenty") {
    if (TWENTY_BROWSE.has(tool)) {
      return "integration_read";
    }

    // execute_tool runs an inner tool by name: find_many_people reads,
    // delete_one_company writes.
    if (tool === "execute_tool") {
      const inner =
        isRecord(args) && typeof args.toolName === "string"
          ? args.toolName
          : "";

      return isReadName(inner) ? "integration_read" : "integration_write";
    }
  }

  return isReadName(tool) ? "integration_read" : "integration_write";
}
