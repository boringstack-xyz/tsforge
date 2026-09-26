import { TOOL_NAME } from "../../agent/agent.constants";
import type { ISiteToolSchema } from "../site-plugins.types";
import {
  LISTING_SORTS,
  SEARCH_SORTS,
  THREAD_SORTS,
  TIME_RANGES,
} from "./reddit.constants";

const TOPIC_ARG = {
  type: "string",
  description:
    "the research topic's notes folder (short slug, e.g. 'pickup-wiring-issues'). Images go to notes/<topic>/assets/, every thread read is logged in notes/<topic>/sources.md, and threads already logged are flagged 'already read'.",
};

export const REDDIT_SEARCH_TOOL: ISiteToolSchema = {
  type: "function",
  function: {
    name: TOOL_NAME.redditSearch,
    description:
      "Search Reddit (through the user's logged-in browser) and get one line per post: id, subreddit, score, comment count, age, 📷 when it has images, 'already read' when this topic logged it. Much cheaper than browsing search pages. Use several phrasings per angle; sort=top with time=year|all for depth, sort=new for current pain.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "search words (Reddit syntax: quotes, OR, -word)",
        },
        subreddit: {
          type: "string",
          description: "limit to one subreddit, e.g. 'Guitar' (optional)",
        },
        sort: {
          type: "string",
          enum: [...SEARCH_SORTS],
          description: "default relevance",
        },
        time: {
          type: "string",
          enum: [...TIME_RANGES],
          description: "default all",
        },
        limit: { type: "number", description: "1–100, default 25" },
        after: {
          type: "string",
          description: "the `after` value from the previous page",
        },
        topic: TOPIC_ARG,
      },
      required: ["query"],
    },
  },
};

export const REDDIT_THREAD_TOOL: ISiteToolSchema = {
  type: "function",
  function: {
    name: TOOL_NAME.redditThread,
    description:
      "Read a whole Reddit thread — the post plus the full comment tree with collapsed replies already expanded — as compact markdown, one chunk at a time. Downloads the post's and comments' images into notes/<topic>/assets/<id>/ and shows them inline (look at one with read_image only when it matters). Logs the thread in notes/<topic>/sources.md. Call again with chunk N+1 for the rest (served from cache, no refetch).",
    parameters: {
      type: "object",
      properties: {
        post: {
          type: "string",
          description: "post id (e.g. '1abc2d') or any Reddit post URL",
        },
        topic: TOPIC_ARG,
        chunk: { type: "number", description: "1-based chunk (default 1)" },
        sort: {
          type: "string",
          enum: [...THREAD_SORTS],
          description: "comment order, default top",
        },
        maxComments: {
          type: "number",
          description:
            "comment budget incl. expanded replies, default 500, max 2000",
        },
        force: {
          type: "boolean",
          description:
            "re-read a thread already logged for this topic (normally it is skipped)",
        },
      },
      required: ["post", "topic"],
    },
  },
};

export const REDDIT_LISTING_TOOL: ISiteToolSchema = {
  type: "function",
  function: {
    name: TOOL_NAME.redditListing,
    description:
      "Browse a subreddit's posts (hot / new / top / rising), one line per post — for 'what are people discussing in r/X right now'.",
    parameters: {
      type: "object",
      properties: {
        subreddit: { type: "string", description: "e.g. 'Guitar'" },
        sort: {
          type: "string",
          enum: [...LISTING_SORTS],
          description: "default hot",
        },
        time: {
          type: "string",
          enum: [...TIME_RANGES],
          description: "only for sort=top, default all",
        },
        limit: { type: "number", description: "1–100, default 25" },
        after: {
          type: "string",
          description: "the `after` value from the previous page",
        },
        topic: TOPIC_ARG,
      },
      required: ["subreddit"],
    },
  },
};

export const REDDIT_SUBREDDITS_TOOL: ISiteToolSchema = {
  type: "function",
  function: {
    name: TOOL_NAME.redditSubreddits,
    description:
      "Find the subreddits for a domain (name, members, description) — do this first so searches target the right communities.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "domain words, e.g. 'guitar electronics'",
        },
        limit: { type: "number", description: "1–100, default 15" },
      },
      required: ["query"],
    },
  },
};

export const REDDIT_MARK_READ_TOOL: ISiteToolSchema = {
  type: "function",
  function: {
    name: TOOL_NAME.redditMarkRead,
    description:
      "Record threads you already covered some other way (an earlier crawl, a URL list you processed) in notes/<topic>/sources.md, so reddit_search flags them 'already read' and reddit_thread skips them. Call it once when resuming older research.",
    parameters: {
      type: "object",
      properties: {
        topic: TOPIC_ARG,
        posts: {
          type: "array",
          items: { type: "string" },
          description: "post ids or Reddit post URLs (up to 500 per call)",
        },
      },
      required: ["topic", "posts"],
    },
  },
};

export const REDDIT_TOOLS: readonly ISiteToolSchema[] = [
  REDDIT_SUBREDDITS_TOOL,
  REDDIT_SEARCH_TOOL,
  REDDIT_LISTING_TOOL,
  REDDIT_THREAD_TOOL,
  REDDIT_MARK_READ_TOOL,
];
