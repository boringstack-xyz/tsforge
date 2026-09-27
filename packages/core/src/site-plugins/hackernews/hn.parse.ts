/** Algolia HN JSON → typed shapes (guarded; unknown shapes are skipped). */
import { isArray, isRecord } from "../../lib/guards/guards";

type Obj = Record<string, unknown>;

export interface IHnHit {
  id: number;
  title: string;
  url: string;
  author: string;
  points: number;
  comments: number;
  createdAt: number;
  /** For comment hits: the story it belongs to. */
  storyTitle: string;
  storyId: number | null;
  text: string;
}

export interface IHnItem {
  id: number;
  type: string;
  author: string | null;
  title: string;
  url: string;
  points: number;
  createdAt: number;
  /** Raw HTML (comments, Ask HN text). */
  text: string;
  children: IHnItem[];
}

function str(o: Obj, k: string): string {
  const v = o[k];

  return typeof v === "string" ? v : "";
}

function num(o: Obj, k: string): number {
  const v = o[k];

  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function firstText(a: string, b: string): string {
  return a.length > 0 ? a : b;
}

export function parseHits(
  value: unknown
): { hits: IHnHit[]; page: number; pages: number } | null {
  if (!isRecord(value) || !isArray(value.hits)) {
    return null;
  }

  const hits = value.hits.flatMap((h): IHnHit[] => {
    if (!isRecord(h)) {
      return [];
    }

    const id = Number(str(h, "objectID"));
    const storyId = h.story_id;

    return Number.isInteger(id) && id > 0
      ? [
          {
            id,
            title: str(h, "title"),
            url: str(h, "url"),
            author: str(h, "author"),
            points: num(h, "points"),
            comments: num(h, "num_comments"),
            createdAt: num(h, "created_at_i"),
            storyTitle: str(h, "story_title"),
            storyId: typeof storyId === "number" ? storyId : null,
            text: firstText(str(h, "comment_text"), str(h, "story_text")),
          },
        ]
      : [];
  });

  return { hits, page: num(value, "page"), pages: num(value, "nbPages") };
}

export function parseItem(value: unknown): IHnItem | null {
  if (!isRecord(value) || typeof value.id !== "number") {
    return null;
  }

  const author = value.author;

  return {
    id: value.id,
    type: str(value, "type"),
    author: typeof author === "string" ? author : null,
    title: str(value, "title"),
    url: str(value, "url"),
    points: num(value, "points"),
    createdAt: num(value, "created_at_i"),
    text: str(value, "text"),
    children: isArray(value.children)
      ? value.children.flatMap((c) => {
          const item = parseItem(c);

          return item === null ? [] : [item];
        })
      : [],
  };
}

/** Deleted/dead comments come back with no author and no text. */
export function isGone(item: IHnItem): boolean {
  return item.author === null && item.text.trim().length === 0;
}

export function countItems(list: readonly IHnItem[]): number {
  return list.reduce(
    (n, c) => n + (isGone(c) ? 0 : 1) + countItems(c.children),
    0
  );
}
