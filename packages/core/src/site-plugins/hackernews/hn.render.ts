/** HN data → compact markdown: story header, text, nested comments. */
import { htmlFragmentToMarkdown } from "../../lib/html";
import { age, clip, hostOf, indent, oneLine } from "../format";
import { isGone, type IHnHit, type IHnItem } from "./hn.parse";
import { itemUrl } from "./hn.urls";

const MAX_TEXT_CHARS = 3000;

async function renderComment(
  c: IHnItem,
  depth: number,
  now: Date,
  out: string[]
): Promise<void> {
  const pad = "  ".repeat(depth);

  if (!isGone(c)) {
    const text = clip(await htmlFragmentToMarkdown(c.text), MAX_TEXT_CHARS);

    out.push(`${pad}- ${c.author ?? "[deleted]"} · ${age(c.createdAt, now)}:`);
    out.push(...indent(text, `${pad}  `));
  } else if (c.children.length > 0) {
    out.push(`${pad}- [deleted]`);
  }

  for (const r of c.children) {
    await renderComment(r, depth + 1, now, out);
  }
}

export async function renderThread(item: IHnItem, now: Date): Promise<string> {
  const title =
    item.title.length > 0 ? item.title : `HN item ${String(item.id)}`;
  const out = [
    `# [HN] ${title} (${String(item.points)} points · ${age(item.createdAt, now)} · ${item.author ?? "[deleted]"})`,
    `Source: ${itemUrl(item.id)}`,
    ...(item.url.length > 0 ? [`Link: ${item.url}`] : []),
    "",
  ];

  if (item.text.trim().length > 0) {
    out.push(clip(await htmlFragmentToMarkdown(item.text), MAX_TEXT_CHARS), "");
  }

  out.push("## Comments", "");

  const lines: string[] = [];

  for (const c of item.children) {
    await renderComment(c, 0, now, lines);
  }

  out.push(...(lines.length > 0 ? lines : ["(no comments)"]));

  return out.join("\n");
}

export function hitLine(h: IHnHit, now: Date, alreadyRead: boolean): string {
  const read = alreadyRead ? " · already read" : "";

  if (h.title.length === 0) {
    // A comment hit: show where it was said and a snippet.
    return `- ${String(h.id)} · comment by ${h.author} · ${age(h.createdAt, now)}${read} — on "${clip(oneLine(h.storyTitle), 100)}": ${clip(oneLine(h.text.replace(/<[^>]+>/gu, " ")), 160)}`;
  }

  const domain = hostOf(h.url);

  return `- ${String(h.id)} · ${String(h.points)} points · ${String(h.comments)} comments · ${age(h.createdAt, now)}${read} — ${clip(oneLine(h.title), 160)}${domain.length > 0 ? ` (${domain})` : ""}`;
}
