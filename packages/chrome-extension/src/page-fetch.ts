/**
 * The in-page half of `page.fetch`, run by the content script so the request
 * is a same-origin one carrying the user's cookies — exactly like the page's
 * own requests. GET only, no custom headers, no body; a redirect that leaves
 * the origin is refused, and so are non-text or oversized responses.
 */
import {
  fetchUrlProblem,
  isTextContentType,
  MAX_FETCH_BYTES,
} from "./fetch-policy";

export interface IPageFetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The page's own URL (location.href). */
  pageUrl: () => string;
}

export type PageFetchReply =
  | {
      status: number;
      contentType: string;
      body: string;
      truncated: false;
      retryAfter?: string;
    }
  | { error: string };

export async function pageFetch(
  raw: unknown,
  deps: IPageFetchDeps
): Promise<PageFetchReply> {
  const problem = fetchUrlProblem(raw, deps.pageUrl());

  if (problem !== null || typeof raw !== "string") {
    return { error: problem ?? "missing url" };
  }

  const res = await deps.fetch(raw, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
  });

  if (res.url.length > 0 && new URL(res.url).origin !== new URL(raw).origin) {
    return { error: "the response redirected to another site — refused" };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const retry = res.headers.get("retry-after");
  const extra = retry === null ? {} : { retryAfter: retry };

  // Error pages (429 / 5xx) are passed back with their status so tsforge can
  // back off, whatever their content type.
  if (!res.ok) {
    return {
      status: res.status,
      contentType,
      body: "",
      truncated: false,
      ...extra,
    };
  }

  if (!isTextContentType(contentType)) {
    return {
      error: `not a JSON/text response (${contentType.length > 0 ? contentType : "no content-type"})`,
    };
  }

  const body = await res.text();

  if (body.length > MAX_FETCH_BYTES) {
    return { error: "response larger than 5 MB — refused" };
  }

  return { status: res.status, contentType, body, truncated: false, ...extra };
}
