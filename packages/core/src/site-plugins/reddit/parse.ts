/**
 * Reddit JSON → the typed shapes in reddit.types.ts. Every read is guarded;
 * anything unrecognised is skipped rather than trusted, and a page that is not
 * a Reddit listing at all parses to null.
 */
import { isArray, isRecord } from "../../lib/guards/guards";
import { commentImages, postImages, postVideo } from "./media";
import type {
  IListingPage,
  IMoreStub,
  IRedditComment,
  IRedditPost,
  IRedditThread,
  ISubredditInfo,
} from "./reddit.types";

type Obj = Record<string, unknown>;

export function text(o: Obj, key: string): string {
  const v = o[key];

  return typeof v === "string" ? v : "";
}

export function num(o: Obj, key: string): number {
  const v = o[key];

  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `{ kind, data }` things of a listing, as [kind, data] pairs. */
function things(listing: unknown): [string, Obj][] {
  if (
    !isRecord(listing) ||
    !isRecord(listing.data) ||
    !isArray(listing.data.children)
  ) {
    return [];
  }

  return listing.data.children.flatMap((c): [string, Obj][] =>
    isRecord(c) && typeof c.kind === "string" && isRecord(c.data)
      ? [[c.kind, c.data]]
      : []
  );
}

function isListing(value: unknown): boolean {
  return isRecord(value) && value.kind === "Listing" && isRecord(value.data);
}

export function parsePost(d: Obj): IRedditPost | null {
  const id = text(d, "id");

  if (id.length === 0) {
    return null;
  }

  return {
    id,
    title: text(d, "title"),
    subreddit: text(d, "subreddit"),
    author: text(d, "author"),
    score: num(d, "score"),
    numComments: num(d, "num_comments"),
    createdUtc: num(d, "created_utc"),
    permalink: text(d, "permalink"),
    url: text(d, "url"),
    selftext: text(d, "selftext"),
    over18: d.over_18 === true,
    stickied: d.stickied === true,
    images: postImages(d),
    videoUrl: postVideo(d),
  };
}

export function parseMore(d: Obj): IMoreStub {
  const ids = isArray(d.children)
    ? d.children.filter((c): c is string => typeof c === "string" && c !== "_")
    : [];

  return { parentId: text(d, "parent_id"), ids, count: num(d, "count") };
}

export function parseComment(d: Obj): IRedditComment {
  const replies: IRedditComment[] = [];
  const more: IMoreStub[] = [];

  for (const [kind, child] of things(d.replies)) {
    if (kind === "t1") {
      replies.push(parseComment(child));
    } else if (kind === "more") {
      more.push(parseMore(child));
    }
  }

  const distinguished = d.distinguished;

  return {
    id: text(d, "id"),
    author: text(d, "author"),
    body: text(d, "body"),
    score: num(d, "score"),
    createdUtc: num(d, "created_utc"),
    isSubmitter: d.is_submitter === true,
    stickied: d.stickied === true,
    distinguished: typeof distinguished === "string" ? distinguished : null,
    replies,
    more,
    images: commentImages(d),
  };
}

/** `/comments/<id>.json` → [post listing, comment listing]. */
export function parseThread(value: unknown): IRedditThread | null {
  if (
    !isArray(value) ||
    value.length < 2 ||
    !isListing(value[0]) ||
    !isListing(value[1])
  ) {
    return null;
  }

  const postData = things(value[0]).find(([kind]) => kind === "t3")?.[1];
  const post = postData === undefined ? null : parsePost(postData);

  if (post === null) {
    return null;
  }

  const comments: IRedditComment[] = [];
  const more: IMoreStub[] = [];

  for (const [kind, d] of things(value[1])) {
    if (kind === "t1") {
      comments.push(parseComment(d));
    } else if (kind === "more") {
      more.push(parseMore(d));
    }
  }

  return { post, comments, more };
}

export interface IMoreChildItem {
  parentId: string;
  comment?: IRedditComment;
  more?: IMoreStub;
}

/** `/api/morechildren.json` → a FLAT list of comments/stubs carrying parents. */
export function parseMoreChildren(value: unknown): IMoreChildItem[] | null {
  const list =
    isRecord(value) &&
    isRecord(value.json) &&
    isRecord(value.json.data) &&
    isArray(value.json.data.things)
      ? value.json.data.things
      : null;

  if (list === null) {
    return null;
  }

  return list.flatMap((t): IMoreChildItem[] => {
    if (!isRecord(t) || !isRecord(t.data)) {
      return [];
    }

    const parentId = text(t.data, "parent_id");

    if (t.kind === "t1") {
      return [{ parentId, comment: parseComment(t.data) }];
    }

    return t.kind === "more" ? [{ parentId, more: parseMore(t.data) }] : [];
  });
}

export function parseListing(value: unknown): IListingPage | null {
  if (!isListing(value) || !isRecord(value) || !isRecord(value.data)) {
    return null;
  }

  const after = value.data.after;

  return {
    posts: things(value).flatMap(([kind, d]) => {
      const post = kind === "t3" ? parsePost(d) : null;

      return post === null ? [] : [post];
    }),
    after: typeof after === "string" && after.length > 0 ? after : null,
  };
}

export function parseSubreddits(value: unknown): ISubredditInfo[] | null {
  if (!isListing(value)) {
    return null;
  }

  return things(value).flatMap(([kind, d]) =>
    kind === "t5"
      ? [
          {
            name: text(d, "display_name"),
            subscribers: num(d, "subscribers"),
            description: text(d, "public_description"),
            over18: d.over18 === true,
          },
        ]
      : []
  );
}
