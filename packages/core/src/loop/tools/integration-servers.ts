import { flags } from "../../config";

/** The curated MCP-integration server keys, in advertisement order. */
export const INTEGRATION_SERVERS = [
  "linear",
  "notion",
  "sentry",
  "twenty",
] as const;

export interface IIntegrationCaps {
  linear?: boolean;
  notion?: boolean;
  sentry?: boolean;
  twenty?: boolean;
}

/** Whether each integration's full raw toolset is offered (default yes;
 *  TSFORGE_<NAME>_RAW=0 hides it behind the curated verbs). */
const RAW_FLAG: Record<(typeof INTEGRATION_SERVERS)[number], () => boolean> = {
  linear: () => flags.linearRaw(),
  notion: () => flags.notionRaw(),
  sentry: () => flags.sentryRaw(),
  twenty: () => flags.twentyRaw(),
};

/**
 * The server keys whose raw `mcp__<server>__*` tools should be hidden from the
 * model — a curated capability is ON for it and the user switched its raw
 * toolset off (TSFORGE_<NAME>_RAW=0). By default nothing is hidden: the curated
 * verbs are shortcuts, not a cap on what the agent can do.
 * Fed to {@link suppressCuratedSchemas} so the model sees the curated verbs, not the
 * dozens of raw tools underneath.
 */
export function suppressedIntegrationServers(caps: IIntegrationCaps): string[] {
  const on: Record<(typeof INTEGRATION_SERVERS)[number], boolean> = {
    linear: caps.linear === true,
    notion: caps.notion === true,
    sentry: caps.sentry === true,
    twenty: caps.twenty === true,
  };

  return INTEGRATION_SERVERS.filter((s) => on[s] && !RAW_FLAG[s]());
}
