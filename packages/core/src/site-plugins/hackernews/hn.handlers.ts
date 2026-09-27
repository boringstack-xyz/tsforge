/** hn_search / hn_thread handlers — never throw; failures come back as advice. */
import { chunkMarkdown, READ_CHUNK_CHARS } from "../../chrome-bridge";
import { directFetchJson } from "../direct-fetch";
import { describeFailure } from "../page-fetch";
import {
  cacheChunks,
  cachedChunks,
  isLogged,
  logSource,
  refusedRead,
  serveChunk,
  UNTRUSTED,
} from "../reading";
import type { FetchOutcome, SitePluginHandler } from "../site-plugins.types";
import { countItems, parseHits, parseItem } from "./hn.parse";
import { hitLine, renderThread } from "./hn.render";
import {
  HN_API_HOST,
  HN_HOSTS,
  itemPath,
  itemUrl,
  parseItemId,
  searchPath,
  SITE,
} from "./hn.urls";

export interface IHnDeps {
  now: () => Date;
  fetchJson: (path: string) => Promise<FetchOutcome<unknown>>;
}

const DEFAULT_DEPS: IHnDeps = {
  now: () => new Date(),
  fetchJson: (path) => directFetchJson(HN_HOSTS, HN_API_HOST, path),
};

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v.trim() : "";
}

function optional(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const v = str(args, key);

  return v.length > 0 ? v : undefined;
}

export function createHnHandlers(
  deps: IHnDeps = DEFAULT_DEPS
): Record<string, SitePluginHandler> {
  const search: SitePluginHandler = async (args, ctx) => {
    const query = str(args, "query");

    if (query.length === 0) {
      return "hn_search: `query` is required.";
    }

    ctx.progress(`↳ hn_search "${query}"`);

    const now = deps.now();
    const res = await deps.fetchJson(
      searchPath(
        {
          query,
          sort: args.sort,
          type: args.type,
          time: args.time,
          limit: args.limit,
          page: args.page,
        },
        Math.floor(now.getTime() / 1000)
      )
    );

    if (!res.ok) {
      return describeFailure("hn search", res);
    }

    const page = parseHits(res.value);

    if (page === null) {
      return "hn search: unexpected response.";
    }

    if (page.hits.length === 0) {
      return `HN search "${query}": no results.`;
    }

    const topic = optional(args, "topic");
    const lines: string[] = [];

    for (const h of page.hits) {
      lines.push(
        hitLine(
          h,
          now,
          await isLogged(
            ctx.stateKey,
            ctx.cwd,
            topic,
            `${SITE}:${String(h.storyId ?? h.id)}`
          )
        )
      );
    }

    const more =
      page.page + 1 < page.pages
        ? `More: pass page: ${String(page.page + 1)}.`
        : "(last page)";

    return [
      `HN search "${query}" — ${String(page.hits.length)} results`,
      ...lines,
      "",
      more,
      `Read one with hn_thread item: <id>${topic === undefined ? ", topic: <slug>" : `, topic: "${topic}"`}.`,
      UNTRUSTED,
    ].join("\n");
  };

  const thread: SitePluginHandler = async (args, ctx) => {
    const id = parseItemId(args.item);
    const topic = str(args, "topic");

    if (id === null || topic.length === 0) {
      return "hn_thread: `item` (an id or news.ycombinator.com/item?id=… URL) and `topic` are required.";
    }

    const key = `${SITE}:${String(id)}`;
    const chunk = typeof args.chunk === "number" ? Math.floor(args.chunk) : 1;
    const force = args.force === true;
    const next = (n: number): string =>
      `hn_thread item: "${String(id)}", topic: "${topic}", chunk: ${String(n)}`;
    const cached = cachedChunks(ctx.stateKey, key);

    if (cached !== undefined && !force) {
      return serveChunk(`hn_thread ${String(id)}`, cached, chunk, next);
    }

    if (!force && (await isLogged(ctx.stateKey, ctx.cwd, topic, key))) {
      return refusedRead("hn_thread", String(id), topic);
    }

    ctx.progress(`↳ hn_thread ${String(id)}`);

    const res = await deps.fetchJson(itemPath(id));

    if (!res.ok) {
      return describeFailure(`hn thread ${String(id)}`, res);
    }

    const item = parseItem(res.value);

    if (item === null) {
      return `hn thread ${String(id)}: unexpected response.`;
    }

    const now = deps.now();
    const body = await renderThread(item, now);
    const chunks = chunkMarkdown(
      `${body}\n\n— ${String(countItems(item.children))} comments shown`,
      READ_CHUNK_CHARS
    );

    cacheChunks(ctx.stateKey, key, chunks);
    await logSource(
      ctx.stateKey,
      ctx.cwd,
      topic,
      {
        site: SITE,
        id: String(id),
        title: `[HN] ${item.title.length > 0 ? item.title : `item ${String(id)}`}`,
        url: itemUrl(id),
        meta: `${String(item.points)} points, ${String(countItems(item.children))} comments`,
      },
      now
    );

    return serveChunk(`hn_thread ${String(id)}`, chunks, chunk, next);
  };

  return { hn_search: search, hn_thread: thread };
}
