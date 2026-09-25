/**
 * Local HTML → markdown extraction shared by `web_fetch` and `browser_read`:
 * jsdom + Mozilla Readability + Turndown, lazy-loaded so they cost nothing until
 * a page is actually read.
 */
import type { JSDOM as JSDOMType } from "jsdom";
import type { Readability as ReadabilityType } from "@mozilla/readability";
import type TurndownService from "turndown";

export interface IHtmlLibs {
  JSDOM: typeof JSDOMType;
  Readability: typeof ReadabilityType;
  Turndown: typeof TurndownService;
}

let libs: Promise<IHtmlLibs> | null = null;

export function loadHtmlLibs(): Promise<IHtmlLibs> {
  libs ??= Promise.all([
    import("jsdom"),
    import("@mozilla/readability"),
    import("turndown"),
  ]).then(([jsdom, readability, turndown]) => ({
    JSDOM: jsdom.JSDOM,
    Readability: readability.Readability,
    Turndown: turndown.default,
  }));

  return libs;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Readable article markdown for a fetched page. Falls back to a crude
 *  tag-strip if the libs are unavailable or parsing fails. */
export async function htmlToReadableMarkdown(
  html: string,
  url: string
): Promise<string> {
  try {
    const { JSDOM, Readability, Turndown } = await loadHtmlLibs();

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const content = article?.content ?? "";

    if (content.length === 0) {
      return stripTags(html);
    }

    const title = article?.title ?? "";
    const body = new Turndown().turndown(content);

    return title.length > 0 ? `# ${title}\n\n${body}` : body;
  } catch {
    return stripTags(html);
  }
}
