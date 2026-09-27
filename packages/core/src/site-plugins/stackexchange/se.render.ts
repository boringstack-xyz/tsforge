/** Stack Exchange question + answers → compact markdown. */
import { htmlFragmentToMarkdown } from "../../lib/html";
import { age, clip, oneLine } from "../format";
import type { ISeAnswer, ISeQuestion } from "./se.parse";

const MAX_BODY_CHARS = 6000;

export async function renderQuestion(
  site: string,
  q: ISeQuestion,
  answers: readonly ISeAnswer[],
  now: Date
): Promise<string> {
  const out = [
    `# [${site}] ${q.title} (score ${String(q.score)} · ${String(q.answers)} answers${q.accepted ? " · ✓ accepted" : ""} · ${age(q.created, now)} · ${q.author})`,
    `Source: ${q.link}`,
    ...(q.tags.length > 0 ? [`Tags: ${q.tags.join(", ")}`] : []),
    "",
    clip(await htmlFragmentToMarkdown(q.body), MAX_BODY_CHARS),
    "",
    "## Answers (by votes)",
    "",
  ];

  if (answers.length === 0) {
    out.push("(no answers)");
  }

  for (const a of answers) {
    out.push(
      `### ${a.accepted ? "✓ Accepted — " : ""}score ${String(a.score)} · ${a.author} · ${age(a.created, now)}`,
      ""
    );
    out.push(clip(await htmlFragmentToMarkdown(a.body), MAX_BODY_CHARS), "");
  }

  return out.join("\n").trimEnd();
}

export function questionLine(
  site: string,
  q: ISeQuestion,
  now: Date,
  alreadyRead: boolean
): string {
  const marks = [
    ...(q.accepted ? ["✓"] : []),
    ...(alreadyRead ? ["already read"] : []),
  ];

  return `- ${site}/${String(q.id)} · score ${String(q.score)} · ${String(q.answers)} answers · ${age(q.created, now)}${marks.length > 0 ? ` · ${marks.join(" ")}` : ""} — ${clip(oneLine(q.title), 160)}${q.tags.length > 0 ? ` [${q.tags.slice(0, 5).join(", ")}]` : ""}`;
}
