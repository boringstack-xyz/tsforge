import type { ISitePlugin } from "../site-plugins.types";
import { REDDIT_GUIDANCE } from "./guidance";
import { createRedditHandlers } from "./handlers";
import { REDDIT_HOSTS } from "./reddit.constants";
import { REDDIT_TOOLS } from "./tools";

export { createRedditHandlers, type IRedditDeps } from "./handlers";
export { REDDIT_GUIDANCE, REDDIT_MARKER } from "./guidance";
export { REDDIT_HOSTS, REDDIT_MEDIA_HOSTS } from "./reddit.constants";

export const REDDIT_PLUGIN: ISitePlugin = {
  id: "reddit",
  hosts: REDDIT_HOSTS,
  tools: REDDIT_TOOLS,
  guidance: REDDIT_GUIDANCE,
  handlers: createRedditHandlers(),
};
