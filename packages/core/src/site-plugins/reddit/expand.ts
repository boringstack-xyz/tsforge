/**
 * Fill in collapsed replies so the agent reads the WHOLE discussion without
 * clicking "load more": `more` stubs with ids go through the morechildren
 * endpoint (≤100 ids per call), id-less stubs ("continue this thread") fetch
 * the subtree under their parent comment. Shallow stubs first — top-level
 * replies carry more signal than the tail of one deep argument. Stops at the
 * comment budget, the request cap, or the first failed request.
 */
import type { FetchOutcome } from "../site-plugins.types";
import { parseMoreChildren, parseThread } from "./parse";
import { MAX_EXPAND_REQUESTS, MORECHILDREN_BATCH } from "./reddit.constants";
import type { IMoreStub, IRedditComment, IRedditThread } from "./reddit.types";
import { continuePath, moreChildrenPath } from "./urls";

export type JsonFetcher = (path: string) => Promise<FetchOutcome<unknown>>;

export interface IExpandStats {
  requests: number;
  added: number;
  /** Replies still collapsed (Reddit's own counts) when expansion stopped. */
  remaining: number;
  error: string | null;
}

interface IPending {
  /** The comment holding the stub, or null for a top-level stub. */
  owner: IRedditComment | null;
  stub: IMoreStub;
}

export function countComments(list: readonly IRedditComment[]): number {
  return list.reduce((n, c) => n + 1 + countComments(c.replies), 0);
}

function indexTree(
  list: readonly IRedditComment[],
  index: Map<string, IRedditComment>
): void {
  for (const c of list) {
    index.set(c.id, c);
    indexTree(c.replies, index);
  }
}

function pendingOf(thread: IRedditThread): IPending[] {
  const out: IPending[] = thread.more.map((stub) => ({ owner: null, stub }));

  const walk = (list: readonly IRedditComment[]): void => {
    for (const c of list) {
      out.push(...c.more.map((stub) => ({ owner: c, stub })));
    }

    for (const c of list) {
      walk(c.replies);
    }
  };

  walk(thread.comments);

  return out;
}

function detach(thread: IRedditThread, p: IPending): void {
  const list = p.owner === null ? thread.more : p.owner.more;
  const i = list.indexOf(p.stub);

  if (i >= 0) {
    list.splice(i, 1);
  }
}

interface IExpandRun {
  thread: IRedditThread;
  index: Map<string, IRedditComment>;
  queue: IPending[];
  stats: IExpandStats;
}

function childrenOf(
  run: IExpandRun,
  parentId: string
): { list: IRedditComment[]; owner: IRedditComment | null } | null {
  if (parentId.startsWith("t3_")) {
    return { list: run.thread.comments, owner: null };
  }

  const owner = run.index.get(parentId.replace(/^t1_/u, "")) ?? null;

  return owner === null ? null : { list: owner.replies, owner };
}

async function expandBatch(
  run: IExpandRun,
  p: IPending,
  fetchJson: JsonFetcher,
  postId: string,
  sort: unknown
): Promise<string | null> {
  const batch = p.stub.ids.slice(0, MORECHILDREN_BATCH);
  const res = await fetchJson(moreChildrenPath(postId, batch, sort));

  run.stats.requests += 1;

  if (!res.ok) {
    return res.failure.message;
  }

  const items = parseMoreChildren(res.value);

  if (items === null) {
    return "morechildren: unexpected response";
  }

  p.stub.ids = p.stub.ids.slice(batch.length);
  p.stub.count = Math.max(p.stub.count - batch.length, p.stub.ids.length);

  if (p.stub.ids.length === 0) {
    detach(run.thread, p);
  } else {
    run.queue.unshift(p);
  }

  for (const item of items) {
    const target = childrenOf(run, item.parentId);

    if (target === null) {
      continue;
    }

    if (item.comment !== undefined) {
      target.list.push(item.comment);
      run.index.set(item.comment.id, item.comment);
      run.stats.added += 1;
    } else if (item.more !== undefined) {
      (target.owner === null ? run.thread.more : target.owner.more).push(
        item.more
      );
      run.queue.push({ owner: target.owner, stub: item.more });
    }
  }

  return null;
}

async function expandContinue(
  run: IExpandRun,
  p: IPending,
  fetchJson: JsonFetcher,
  postId: string,
  sort: unknown
): Promise<string | null> {
  const parentId = p.stub.parentId.replace(/^t1_/u, "");
  const res = await fetchJson(continuePath(postId, parentId, sort));

  run.stats.requests += 1;

  if (!res.ok) {
    return res.failure.message;
  }

  const sub = parseThread(res.value);
  const root = sub?.comments.find((c) => c.id === parentId);
  const owner = run.index.get(parentId);

  detach(run.thread, p);

  if (sub === null || root === undefined || owner === undefined) {
    return null;
  }

  owner.replies.push(...root.replies);
  owner.more.push(...root.more);
  indexTree(root.replies, run.index);
  run.stats.added += countComments(root.replies);
  run.queue.push(
    ...pendingOf({ post: sub.post, comments: root.replies, more: [] })
  );
  run.queue.push(...root.more.map((stub) => ({ owner, stub })));

  return null;
}

export async function expandThread(
  thread: IRedditThread,
  fetchJson: JsonFetcher,
  maxComments: number,
  sort: unknown
): Promise<IExpandStats> {
  const run: IExpandRun = {
    thread,
    index: new Map(),
    queue: pendingOf(thread),
    stats: { requests: 0, added: 0, remaining: 0, error: null },
  };

  indexTree(thread.comments, run.index);

  while (
    run.queue.length > 0 &&
    run.stats.requests < MAX_EXPAND_REQUESTS &&
    countComments(thread.comments) < maxComments
  ) {
    const p = run.queue.shift();

    if (p === undefined) {
      break;
    }

    const error =
      p.stub.ids.length > 0
        ? await expandBatch(run, p, fetchJson, thread.post.id, sort)
        : await expandContinue(run, p, fetchJson, thread.post.id, sort);

    if (error !== null) {
      run.stats.error = error;
      break;
    }
  }

  run.stats.remaining = pendingOf(thread).reduce(
    (n, q) => n + Math.max(q.stub.count, q.stub.ids.length),
    0
  );

  return run.stats;
}
