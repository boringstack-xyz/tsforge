import type { ISitePlugin, ISiteRoute } from "../site-plugins.types";
import { createHnHandlers } from "./hn.handlers";
import { HN_GUIDANCE, HN_TOOLS } from "./hn.tools";
import { HN_HOSTS, parseItemId } from "./hn.urls";

export { createHnHandlers, type IHnDeps } from "./hn.handlers";
export { HN_GUIDANCE, HN_MARKER } from "./hn.tools";

/** A news.ycombinator.com item URL → hn_thread. */
export function routeHn(url: URL): ISiteRoute | null {
  const id =
    url.hostname === "news.ycombinator.com" ? parseItemId(url.href) : null;

  return id === null
    ? null
    : {
        tool: "hn_thread",
        args: { item: String(id) },
        key: `hn:${String(id)}`,
        hint: `hn_thread item:"${String(id)}"`,
      };
}

export const HACKERNEWS_PLUGIN: ISitePlugin = {
  id: "hackernews",
  transport: "direct",
  hosts: HN_HOSTS,
  tools: HN_TOOLS,
  guidance: HN_GUIDANCE,
  handlers: createHnHandlers(),
  route: routeHn,
};
