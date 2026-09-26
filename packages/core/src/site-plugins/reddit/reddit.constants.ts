/** Where Reddit JSON is fetched from (through the user's tab). The extension
 *  has its own compiled-in copy of this list and refuses anything else. */
export const REDDIT_HOST = "www.reddit.com";
export const REDDIT_HOSTS = ["www.reddit.com", "old.reddit.com"] as const;

/** Public media hosts images are downloaded from (directly, no login). */
export const REDDIT_MEDIA_HOSTS = [
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "i.imgur.com",
] as const;

export const SITE = "reddit";

export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_LISTING_LIMIT = 100;
export const DEFAULT_MAX_COMMENTS = 500;
export const MAX_MAX_COMMENTS = 2000;
/** Reddit's morechildren endpoint takes at most 100 ids per call. */
export const MORECHILDREN_BATCH = 100;
/** Hard cap on expansion requests per thread, whatever the comment budget. */
export const MAX_EXPAND_REQUESTS = 40;
export const MAX_ASSETS_PER_THREAD = 30;

export const SEARCH_SORTS = ["relevance", "top", "new", "comments"] as const;
export const LISTING_SORTS = ["hot", "new", "top", "rising"] as const;
export const THREAD_SORTS = ["top", "best", "new"] as const;
export const TIME_RANGES = [
  "hour",
  "day",
  "week",
  "month",
  "year",
  "all",
] as const;
