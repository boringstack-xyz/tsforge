/** Stack Exchange API JSON → typed shapes (guarded). */
import { isArray, isRecord } from "../../lib/guards/guards";
import { decodeEntities } from "../format";

type Obj = Record<string, unknown>;

export interface ISeWrapper {
  items: Obj[];
  hasMore: boolean;
  quotaRemaining: number | null;
  /** Seconds the API asks us to wait before the next call to this method. */
  backoff: number;
}

export interface ISeQuestion {
  id: number;
  title: string;
  score: number;
  answers: number;
  accepted: boolean;
  acceptedAnswerId: number | null;
  tags: string[];
  link: string;
  created: number;
  author: string;
  body: string;
}

export interface ISeAnswer {
  id: number;
  score: number;
  accepted: boolean;
  created: number;
  author: string;
  body: string;
}

function str(o: Obj, k: string): string {
  const v = o[k];

  return typeof v === "string" ? v : "";
}

function num(o: Obj, k: string): number {
  const v = o[k];

  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function owner(o: Obj): string {
  return isRecord(o.owner) ? decodeEntities(str(o.owner, "display_name")) : "";
}

export function parseWrapper(value: unknown): ISeWrapper | null {
  if (!isRecord(value) || !isArray(value.items)) {
    return null;
  }

  const quota = value.quota_remaining;

  return {
    items: value.items.filter((i): i is Obj => isRecord(i)),
    hasMore: value.has_more === true,
    quotaRemaining: typeof quota === "number" ? quota : null,
    backoff: num(value, "backoff"),
  };
}

export function parseQuestion(o: Obj): ISeQuestion | null {
  const id = num(o, "question_id");

  if (id <= 0) {
    return null;
  }

  const acceptedId = o.accepted_answer_id;

  return {
    id,
    title: decodeEntities(str(o, "title")),
    score: num(o, "score"),
    answers: num(o, "answer_count"),
    accepted: typeof acceptedId === "number",
    acceptedAnswerId: typeof acceptedId === "number" ? acceptedId : null,
    tags: isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === "string")
      : [],
    link: str(o, "link"),
    created: num(o, "creation_date"),
    author: owner(o),
    body: str(o, "body"),
  };
}

export function parseAnswer(o: Obj): ISeAnswer | null {
  const id = num(o, "answer_id");

  return id <= 0
    ? null
    : {
        id,
        score: num(o, "score"),
        accepted: o.is_accepted === true,
        created: num(o, "creation_date"),
        author: owner(o),
        body: str(o, "body"),
      };
}
