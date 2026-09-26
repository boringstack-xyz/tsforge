/**
 * Reddit data → compact markdown for the model. One header line per comment
 * (author, score, age) with its text beneath, replies nested one level per
 * depth. Noise is dropped: AutoModerator, moderator stickies, and deleted or
 * removed comments with no replies (kept as a stub when they have replies, so
 * the conversation under them still makes sense).
 */
import type { IExpandStats } from "./expand";
import type {
  IRedditComment,
  IRedditPost,
  IRedditThread,
  ISubredditInfo,
} from "./reddit.types";
import { postUrl } from "./urls";

const MAX_BODY_CHARS = 3000;
const GONE = new Set(["[deleted]", "[removed]"]);

/** What happened to each image URL: saved to a notes path, or failed. */
export type AssetLabels = ReadonlyMap<
  string,
  { rel: string } | { failed: string }
>;

export function age(createdUtc: number, now: Date): string {
  const s = Math.max(0, Math.floor(now.getTime() / 1000 - createdUtc));
  const steps: [number, string][] = [
    [365 * 86_400, "y"],
    [30 * 86_400, "mo"],
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
  ];

  for (const [size, unit] of steps) {
    if (s >= size) {
      return `${String(Math.floor(s / size))}${unit}`;
    }
  }

  return "now";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […]`;
}

function tidyBody(body: string): string {
  return clip(
    body
      .replace(/\r/gu, "")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    MAX_BODY_CHARS
  );
}

export function isNoise(c: IRedditComment): boolean {
  return (
    c.author === "AutoModerator" ||
    (c.stickied && c.distinguished === "moderator") ||
    (GONE.has(c.body.trim()) && c.replies.length === 0)
  );
}

/** Image URLs in the order they are rendered: post first, then comments
 *  depth-first, skipping comments the render drops. */
export function imagesInOrder(thread: IRedditThread): string[] {
  const out = [...thread.post.images];

  const walk = (list: readonly IRedditComment[]): void => {
    for (const c of list) {
      if (!isNoise(c)) {
        out.push(...c.images);
        walk(c.replies);
      }
    }
  };

  walk(thread.comments);

  return [...new Set(out)];
}

function imageLine(
  url: string,
  n: number,
  who: string,
  labels: AssetLabels
): string {
  const label = labels.get(url);

  if (label === undefined || "failed" in label) {
    return `[image ${String(n)}: ${url} — ${who}${label === undefined ? "" : `; not saved: ${label.failed}`}]`;
  }

  return `[image ${String(n)}: ${label.rel} — ${who}]`;
}

interface IRenderCtx {
  now: Date;
  labels: AssetLabels;
  numbering: Map<string, number>;
}

function imageLines(
  urls: readonly string[],
  who: string,
  ctx: IRenderCtx
): string[] {
  return urls.map((u) =>
    imageLine(u, ctx.numbering.get(u) ?? 0, who, ctx.labels)
  );
}

function renderComment(
  c: IRedditComment,
  depth: number,
  ctx: IRenderCtx,
  out: string[]
): void {
  if (isNoise(c)) {
    return;
  }

  const pad = "  ".repeat(depth);
  const op = c.isSubmitter ? " (OP)" : "";
  const body = tidyBody(c.body)
    .split("\n")
    .map((l) => `${pad}  ${l}`.trimEnd());

  out.push(
    `${pad}- u/${c.author}${op} ↑${String(c.score)} · ${age(c.createdUtc, ctx.now)}:`
  );
  out.push(...body);
  out.push(
    ...imageLines(c.images, `comment by u/${c.author}`, ctx).map(
      (l) => `${pad}  ${l}`
    )
  );

  for (const r of c.replies) {
    renderComment(r, depth + 1, ctx, out);
  }

  const hidden = c.more.reduce(
    (n, m) => n + Math.max(m.count, m.ids.length),
    0
  );

  if (hidden > 0) {
    out.push(`${pad}  [+${String(hidden)} more replies not loaded]`);
  }
}

export function renderPostHeader(p: IRedditPost, now: Date): string {
  return `# [r/${p.subreddit}] ${p.title} (↑${String(p.score)} · ${String(p.numComments)} comments · ${age(p.createdUtc, now)} · u/${p.author})`;
}

export function renderThread(
  thread: IRedditThread,
  labels: AssetLabels,
  now: Date
): string {
  const { post } = thread;
  const numbering = new Map(imagesInOrder(thread).map((u, i) => [u, i + 1]));
  const ctx: IRenderCtx = { now, labels, numbering };
  const out: string[] = [
    renderPostHeader(post, now),
    `Source: ${postUrl(post.permalink)}`,
    "",
  ];

  if (post.selftext.trim().length > 0) {
    out.push(tidyBody(post.selftext), "");
  } else if (
    post.url.length > 0 &&
    post.images.length === 0 &&
    post.videoUrl === null
  ) {
    out.push(`Link: ${post.url}`, "");
  }

  out.push(...imageLines(post.images, "post", ctx));

  if (post.videoUrl !== null) {
    out.push(`[video: ${post.videoUrl} — not downloaded]`);
  }

  out.push("", "## Comments", "");

  const lines: string[] = [];

  for (const c of thread.comments) {
    renderComment(c, 0, ctx, lines);
  }

  out.push(...(lines.length > 0 ? lines : ["(no comments)"]));

  return out.join("\n");
}

export function renderFooter(
  shown: number,
  total: number,
  stats: IExpandStats,
  saved: number,
  failed: number
): string {
  const parts = [`${String(shown)} of ~${String(total)} comments shown`];

  if (stats.remaining > 0) {
    parts.push(
      `${String(stats.remaining)} collapsed replies not fetched (budget)`
    );
  }

  if (stats.error !== null) {
    parts.push(`expansion stopped early: ${stats.error}`);
  }

  if (saved + failed > 0) {
    parts.push(
      `images: ${String(saved)} saved${failed > 0 ? `, ${String(failed)} failed` : ""}`
    );
  }

  return `— ${parts.join(" · ")}`;
}

/** One line per post, for search results and listings. */
export function postLine(
  p: IRedditPost,
  now: Date,
  alreadyRead: boolean
): string {
  const marks = [
    ...(p.images.length > 0 ? ["📷"] : []),
    ...(p.videoUrl === null ? [] : ["🎞"]),
    ...(p.over18 ? ["nsfw"] : []),
    ...(alreadyRead ? ["already read"] : []),
  ];

  return `- ${p.id} · r/${p.subreddit} · ↑${String(p.score)} · ${String(p.numComments)} comments · ${age(p.createdUtc, now)}${marks.length > 0 ? ` · ${marks.join(" ")}` : ""} — ${clip(p.title.replace(/\s+/gu, " "), 160)}`;
}

export function subredditLine(s: ISubredditInfo): string {
  const nsfw = s.over18 ? " · nsfw" : "";

  return `- r/${s.name} · ${s.subscribers.toLocaleString("en-US")} members${nsfw} — ${clip(s.description.replace(/\s+/gu, " ").trim(), 160)}`;
}
