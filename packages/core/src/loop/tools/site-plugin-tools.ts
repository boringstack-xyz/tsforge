/**
 * Bridge between the harness tool context and the site plugins: a plugin sees
 * only the browser session (browser plugins), the workspace, a state key and a
 * progress reporter.
 */
import { findSiteTool, type ISitePluginContext } from "../../site-plugins";
import { reject, type IToolContext } from "./tool-context";

const OFF =
  "this site tool reads through the user's Chrome — start tsforge with TSFORGE_BROWSER=1 (or enable it in /config) and pair the Chrome extension.";

/** A stable per-workspace object keying direct-plugin state when there is no
 *  browser session (chunk caches, read sets survive across tool calls). */
const WORKSPACE_KEYS = new Map<string, object>();

export function workspaceKey(cwd: string): object {
  let key = WORKSPACE_KEYS.get(cwd);

  if (key === undefined) {
    key = { cwd };
    WORKSPACE_KEYS.set(cwd, key);
  }

  return key;
}

/** The plugin context for a tool call, or an error string (browser plugin
 *  without the bridge). */
export function sitePluginContext(
  ctx: IToolContext,
  transport: "browser" | "direct"
): ISitePluginContext | string {
  const session = ctx.browser;

  if (transport === "browser" && session === undefined) {
    return OFF;
  }

  return {
    ...(session === undefined ? {} : { session }),
    stateKey: session ?? workspaceKey(ctx.cwd),
    cwd: ctx.cwd,
    progress: (message) => {
      ctx.report({ kind: "tool", task: ctx.task, message });
    },
  };
}

export function sitePluginTool(
  name: string
): (args: Record<string, unknown>, ctx: IToolContext) => Promise<string> {
  return async (args, ctx) => {
    const found = findSiteTool(name);

    if (found === undefined) {
      return reject(ctx, name, `${name}: no site plugin provides this tool.`);
    }

    const pluginCtx = sitePluginContext(ctx, found.plugin.transport);

    if (typeof pluginCtx === "string") {
      return reject(ctx, name, pluginCtx);
    }

    try {
      return await found.handler(args, pluginCtx);
    } catch (err) {
      // Handlers are written not to throw; this is the backstop so a plugin bug
      // becomes a tool error instead of ending the turn.
      return `${name}: failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
