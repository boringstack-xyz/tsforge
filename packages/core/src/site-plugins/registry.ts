/**
 * The built-in site plugins. Built-in only by design: browser plugins fetch
 * with the user's logged-in cookies, so plugins ship reviewed, in tsforge's
 * own source. Adding a site = one folder + one entry here (+ its hosts in the
 * extension's compiled-in FETCH_HOSTS for a browser plugin, which a test keeps
 * in sync).
 */
import { HACKERNEWS_PLUGIN } from "./hackernews";
import { REDDIT_PLUGIN } from "./reddit";
import { STACKEXCHANGE_PLUGIN } from "./stackexchange";
import type {
  ISitePlugin,
  ISiteRoute,
  ISiteToolSchema,
  SitePluginHandler,
} from "./site-plugins.types";

export const SITE_PLUGINS: readonly ISitePlugin[] = [
  REDDIT_PLUGIN,
  HACKERNEWS_PLUGIN,
  STACKEXCHANGE_PLUGIN,
];

/** Which research capabilities the session has. */
export interface ISiteCaps {
  browser?: boolean;
  web?: boolean;
}

function offered(plugin: ISitePlugin, caps: ISiteCaps): boolean {
  return plugin.transport === "browser"
    ? caps.browser === true
    : caps.browser === true || caps.web === true;
}

/** Plugin tools for the session: browser plugins with the Chrome bridge,
 *  direct plugins whenever the session can research at all. */
export function sitePluginTools(caps: ISiteCaps): ISiteToolSchema[] {
  return SITE_PLUGINS.filter((p) => offered(p, caps)).flatMap((p) => [
    ...p.tools,
  ]);
}

export function sitePluginGuidance(
  caps: ISiteCaps
): { marker: string; text: string }[] {
  return SITE_PLUGINS.filter((p) => offered(p, caps)).map((p) => ({
    marker: p.guidance.split("\n", 1)[0] ?? p.id,
    text: p.guidance,
  }));
}

/** The plugin that provides tool `name`, with its handler. */
export function findSiteTool(
  name: string
): { plugin: ISitePlugin; handler: SitePluginHandler } | undefined {
  for (const plugin of SITE_PLUGINS) {
    const handler = plugin.handlers[name];

    if (handler !== undefined) {
      return { plugin, handler };
    }
  }

  return undefined;
}

export function findSitePluginHandler(
  name: string
): SitePluginHandler | undefined {
  return findSiteTool(name)?.handler;
}

/** The reader for a URL some plugin owns, or null. */
export function routeUrl(raw: string): ISiteRoute | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  for (const plugin of SITE_PLUGINS) {
    const route = plugin.route?.(url) ?? null;

    if (route !== null) {
      return route;
    }
  }

  return null;
}

/** Hosts browser plugins fetch from through page.fetch (the extension must
 *  allow exactly these). Direct plugins call public APIs themselves. */
export function sitePluginHosts(): string[] {
  return [
    ...new Set(
      SITE_PLUGINS.filter((p) => p.transport === "browser").flatMap((p) => [
        ...p.hosts,
      ])
    ),
  ].sort();
}
