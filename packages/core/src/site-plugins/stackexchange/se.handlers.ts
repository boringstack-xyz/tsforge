/** se_search / se_question handlers — never throw; failures come back as advice. */
import { chunkMarkdown, READ_CHUNK_CHARS } from "../../chrome-bridge";
import { flags } from "../../config/flags";
import { backoffHost, directFetchJson } from "../direct-fetch";
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
import {
  parseAnswer,
  parseQuestion,
  parseWrapper,
  type ISeAnswer,
  type ISeWrapper,
} from "./se.parse";
import { questionLine, renderQuestion } from "./se.render";
import {
  answersPath,
  parseQuestionRef,
  parseSite,
  questionPath,
  SE_API_HOST,
  SE_HOSTS,
  searchPath,
  SITE,
  type IQuestionRef,
} from "./se.urls";

/** The sources.md key for a question: `se:<site>_<id>`. */
export function seKey(ref: IQuestionRef): string {
  return `${SITE}:${ref.site}_${String(ref.id)}`;
}

/** Below this many requests left today, say so in the result. */
const LOW_QUOTA = 50;

export interface ISeDeps {
  now: () => Date;
  key: () => string;
  fetchJson: (path: string) => Promise<FetchOutcome<unknown>>;
  backoff: (seconds: number) => Promise<void>;
}

const DEFAULT_DEPS: ISeDeps = {
  now: () => new Date(),
  key: () => flags.stackExchangeKey(),
  fetchJson: (path) => directFetchJson(SE_HOSTS, SE_API_HOST, path),
  backoff: (seconds) => backoffHost(SE_API_HOST, seconds),
};

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v.trim() : "";
}

function quotaNote(w: ISeWrapper): string {
  return w.quotaRemaining !== null && w.quotaRemaining < LOW_QUOTA
    ? `\n(Stack Exchange quota: ${String(w.quotaRemaining)} requests left today${flags.stackExchangeKey().length > 0 ? "" : " — TSFORGE_STACKEXCHANGE_KEY raises it to 10,000"})`
    : "";
}

export function createSeHandlers(
  deps: ISeDeps = DEFAULT_DEPS
): Record<string, SitePluginHandler> {
  /** One API call: fetch, unwrap, and honour the API's `backoff` request. */
  const call = async (
    path: string,
    label: string
  ): Promise<ISeWrapper | string> => {
    const res = await deps.fetchJson(path);

    if (!res.ok) {
      return describeFailure(label, res);
    }

    const w = parseWrapper(res.value);

    if (w === null) {
      return `${label}: unexpected response.`;
    }

    await deps.backoff(w.backoff);

    return w;
  };

  const search: SitePluginHandler = async (args, ctx) => {
    const query = str(args, "query");
    const site = parseSite(args.site);

    if (query.length === 0 || site === null) {
      return "se_search: `query` is required and `site` must be a Stack Exchange site name (e.g. stackoverflow, electronics).";
    }

    ctx.progress(`↳ se_search "${query}" on ${site}`);

    const w = await call(
      searchPath(
        {
          query,
          site,
          sort: args.sort,
          accepted: args.accepted,
          limit: args.limit,
          page: args.page,
        },
        deps.key()
      ),
      "stack exchange search"
    );

    if (typeof w === "string") {
      return w;
    }

    const now = deps.now();
    const topic = str(args, "topic");
    const lines: string[] = [];

    for (const q of w.items.flatMap((i) => parseQuestion(i) ?? [])) {
      lines.push(
        questionLine(
          site,
          q,
          now,
          await isLogged(
            ctx.stateKey,
            ctx.cwd,
            topic.length > 0 ? topic : undefined,
            seKey({ site, id: q.id })
          )
        )
      );
    }

    if (lines.length === 0) {
      return `Stack Exchange (${site}) "${query}": no questions found.${quotaNote(w)}`;
    }

    return (
      [
        `Stack Exchange (${site}) "${query}" — ${String(lines.length)} questions`,
        ...lines,
        "",
        w.hasMore ? "More: pass the next page." : "(last page)",
        `Read one with se_question question: "<site>/<id>" → pass question: <id>, site: "${site}".`,
        UNTRUSTED,
      ].join("\n") + quotaNote(w)
    );
  };

  const readQuestion = async (
    ref: IQuestionRef
  ): Promise<
    | {
        text: string;
        title: string;
        link: string;
        score: number;
        answers: number;
        quota: string;
      }
    | string
  > => {
    const qw = await call(
      questionPath(ref, deps.key()),
      `stack exchange question ${ref.site}/${String(ref.id)}`
    );

    if (typeof qw === "string") {
      return qw;
    }

    const first = qw.items[0];
    const q = first === undefined ? null : parseQuestion(first);

    if (q === null) {
      return `stack exchange question ${ref.site}/${String(ref.id)}: not found.`;
    }

    const aw =
      q.answers > 0
        ? await call(answersPath(ref, deps.key()), "stack exchange answers")
        : null;
    const answers: ISeAnswer[] =
      aw === null || typeof aw === "string"
        ? []
        : aw.items.flatMap((i) => parseAnswer(i) ?? []);
    // Accepted answer first, then by votes (the API already sorted by votes).
    const ordered = [
      ...answers.filter((a) => a.accepted),
      ...answers.filter((a) => !a.accepted),
    ];

    return {
      text: await renderQuestion(ref.site, q, ordered, deps.now()),
      title: q.title,
      link: q.link,
      score: q.score,
      answers: q.answers,
      quota: quotaNote(aw !== null && typeof aw !== "string" ? aw : qw),
    };
  };

  const question: SitePluginHandler = async (args, ctx) => {
    const ref = parseQuestionRef(args.question, args.site);
    const topic = str(args, "topic");

    if (ref === null || topic.length === 0) {
      return "se_question: `question` (an id with `site`, or a question URL) and `topic` are required.";
    }

    const id = `${ref.site}/${String(ref.id)}`;
    const key = seKey(ref);
    const chunk = typeof args.chunk === "number" ? Math.floor(args.chunk) : 1;
    const force = args.force === true;
    const next = (n: number): string =>
      `se_question question: "${String(ref.id)}", site: "${ref.site}", topic: "${topic}", chunk: ${String(n)}`;
    const cached = cachedChunks(ctx.stateKey, key);

    if (cached !== undefined && !force) {
      return serveChunk(`se_question ${id}`, cached, chunk, next);
    }

    if (!force && (await isLogged(ctx.stateKey, ctx.cwd, topic, key))) {
      return refusedRead("se_question", id, topic);
    }

    ctx.progress(`↳ se_question ${id}`);

    const read = await readQuestion(ref);

    if (typeof read === "string") {
      return read;
    }

    const chunks = chunkMarkdown(read.text, READ_CHUNK_CHARS);

    cacheChunks(ctx.stateKey, key, chunks);
    await logSource(
      ctx.stateKey,
      ctx.cwd,
      topic,
      {
        site: SITE,
        id: `${ref.site}_${String(ref.id)}`,
        title: `[${ref.site}] ${read.title}`,
        url: read.link,
        meta: `score ${String(read.score)}, ${String(read.answers)} answers`,
      },
      deps.now()
    );

    return serveChunk(`se_question ${id}`, chunks, chunk, next) + read.quota;
  };

  return { se_search: search, se_question: question };
}
