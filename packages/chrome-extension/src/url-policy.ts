/** URL rules the extension enforces on its own, whatever tsforge asks. */

/** Only real web pages: http(s). No javascript:, data:, file:, chrome:, … */
export function isNavigableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Words that name an ACTION rather than a place — on a button or a short link
 *  label they mean "do something as the user". Matched as whole words. */
export const ACTION_WORDS: readonly string[] = [
  "post",
  "reply",
  "submit",
  "send",
  "comment",
  "like",
  "unlike",
  "upvote",
  "downvote",
  "vote",
  "react",
  "follow",
  "unfollow",
  "subscribe",
  "unsubscribe",
  "delete",
  "remove",
  "edit",
  "report",
  "flag",
  "block",
  "mute",
  "ban",
  "kick",
  "pin",
  "unpin",
  "star",
  "bookmark",
  "save",
  "share",
  "repost",
  "retweet",
  "quote",
  "buy",
  "purchase",
  "pay",
  "checkout",
  "order",
  "add to cart",
  "sign out",
  "log out",
  "logout",
  "sign in",
  "log in",
  "login",
  "register",
  "sign up",
  "accept",
  "decline",
  "confirm",
  "approve",
  "join",
  "leave",
  "archive",
  "publish",
  "merge",
  "close",
  "install",
  "download",
  "upload",
  "translate",
  "mark as read",
  "solve",
  "accept answer",
];

const ACTION_RE = new RegExp(
  `\\b(?:${ACTION_WORDS.map((w) => w.replace(/ /gu, "\\s+")).join("|")})\\b`,
  "iu"
);

export function hasActionWord(label: string): boolean {
  return ACTION_RE.test(label);
}

const DESTRUCTIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "logout",
  "log-out",
  "log_out",
  "signout",
  "sign-out",
  "sign_out",
  "delete",
  "destroy",
  "remove",
  "unsubscribe",
]);

const ACTION_QUERY_KEYS: ReadonlySet<string> = new Set([
  "action",
  "do",
  "cmd",
  "op",
  "method",
  "mode",
]);

const TOKEN_QUERY_KEYS: ReadonlySet<string> = new Set([
  "csrf",
  "csrf_token",
  "_token",
  "token",
  "nonce",
  "_wpnonce",
  "authenticity_token",
  "sesskey",
  "hash",
]);

/** A GET link that performs an action on a badly-built site: logout/delete
 *  path segments, `?action=delete` / `?mode=logout`, or a CSRF-style token in
 *  the query (phpBB action links carry `hash=`; its plain `sid=` session param
 *  is on every link, so it is NOT treated as a token). Whole segments/keys
 *  only, so `/t/how-to-remove-rust` still reads fine. */
export function isDestructiveUrl(url: URL): boolean {
  const segments = url.pathname.toLowerCase().split("/");

  if (segments.some((s) => DESTRUCTIVE_SEGMENTS.has(s))) {
    return true;
  }

  for (const [key, value] of url.searchParams) {
    const k = key.toLowerCase();

    if (TOKEN_QUERY_KEYS.has(k)) {
      return true;
    }

    if (
      ACTION_QUERY_KEYS.has(k) &&
      hasActionWord(value.replace(/[-_]/gu, " "))
    ) {
      return true;
    }
  }

  return false;
}
