import type { ISitePlugin, ISiteRoute } from "../site-plugins.types";
import { REDDIT_GUIDANCE } from "./guidance";
import { createRedditHandlers } from "./handlers";
import { REDDIT_HOSTS } from "./reddit.constants";
import { REDDIT_TOOLS } from "./tools";
import { parsePostId } from "./urls";

export { createRedditHandlers, type IRedditDeps } from "./handlers";
export { REDDIT_GUIDANCE, REDDIT_MARKER } from "./guidance";
export { REDDIT_HOSTS, REDDIT_MEDIA_HOSTS } from "./reddit.constants";

const REDDIT_URL_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "m.reddit.com",
  "redd.it",
]);

/** A Reddit post URL → reddit_thread. */
export function routeReddit(url: URL): ISiteRoute | null {
  if (!REDDIT_URL_HOSTS.has(url.hostname)) {
    return null;
  }

  const id = parsePostId(url.href);

  return id === null
    ? null
    : {
        tool: "reddit_thread",
        args: { post: id },
        key: `reddit:${id}`,
        hint: `reddit_thread post:"${id}"`,
      };
}

export const REDDIT_PLUGIN: ISitePlugin = {
  id: "reddit",
  transport: "browser",
  hosts: REDDIT_HOSTS,
  tools: REDDIT_TOOLS,
  guidance: REDDIT_GUIDANCE,
  handlers: createRedditHandlers(),
  route: routeReddit,
};
