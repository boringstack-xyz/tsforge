/**
 * Bridge between the harness tool context and the site plugins: a plugin sees
 * only the browser session, the workspace and a progress reporter.
 */
import { findSitePluginHandler } from "../../site-plugins";
import { reject, type IToolContext } from "./tool-context";

const OFF =
  "site tools need the Chrome bridge — start tsforge with TSFORGE_BROWSER=1 (or enable it in /config) and pair the Chrome extension.";

export function sitePluginTool(
  name: string
): (args: Record<string, unknown>, ctx: IToolContext) => Promise<string> {
  return async (args, ctx) => {
    const handler = findSitePluginHandler(name);
    const session = ctx.browser;

    if (handler === undefined) {
      return reject(ctx, name, `${name}: no site plugin provides this tool.`);
    }

    if (session === undefined) {
      return reject(ctx, name, OFF);
    }

    try {
      return await handler(args, {
        session,
        cwd: ctx.cwd,
        progress: (message) => {
          ctx.report({ kind: "tool", task: ctx.task, message });
        },
      });
    } catch (err) {
      // Handlers are written not to throw; this is the backstop so a plugin bug
      // becomes a tool error instead of ending the turn.
      return `${name}: failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
