/**
 * The built-in site plugins. Built-in only by design: a plugin's tools fetch
 * with the user's logged-in cookies, so plugins ship reviewed, in tsforge's
 * own source. Adding a site = one folder + one entry here (+ its hosts in the
 * extension's compiled-in FETCH_HOSTS, which a test keeps in sync).
 */
import { REDDIT_PLUGIN } from "./reddit";
import type {
  ISitePlugin,
  ISiteToolSchema,
  SitePluginHandler,
} from "./site-plugins.types";

export const SITE_PLUGINS: readonly ISitePlugin[] = [REDDIT_PLUGIN];

/** Every plugin tool — advertised only while the browser capability is on. */
export function sitePluginTools(): ISiteToolSchema[] {
  return SITE_PLUGINS.flatMap((p) => [...p.tools]);
}

export function sitePluginGuidance(): { marker: string; text: string }[] {
  return SITE_PLUGINS.map((p) => ({
    marker: p.guidance.split("\n", 1)[0] ?? p.id,
    text: p.guidance,
  }));
}

export function findSitePluginHandler(
  name: string
): SitePluginHandler | undefined {
  for (const p of SITE_PLUGINS) {
    const handler = p.handlers[name];

    if (handler !== undefined) {
      return handler;
    }
  }

  return undefined;
}

/** Hosts any built-in plugin fetches from (the extension must allow exactly these). */
export function sitePluginHosts(): string[] {
  return [...new Set(SITE_PLUGINS.flatMap((p) => [...p.hosts]))].sort();
}
