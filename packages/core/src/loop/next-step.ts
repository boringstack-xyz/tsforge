/**
 * Whether a reply ENDS by announcing an action it did not take: its last line
 * or last sentence reads "Let me record it." / "I'll open the next thread." /
 * "Next, I will…". In a session with no gate, such a reply with no tool call is
 * the model stopping mid-stride, not an answer.
 *
 * Questions and sign-offs to the user ("Let me know if…") are real
 * conversational endings and do not count.
 */
const NEXT_STEP_RE =
  /^(?:(?:ok(?:ay)?|now|next|great|alright|good)[,!.]?\s+)?(?:let me|let's|i'll|i will|i'm going to|i am going to|next,? i(?:'ll| will))\s+(?!know\b)/u;

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();

    if (line.length > 0) {
      return line;
    }
  }

  return undefined;
}

export function announcesNextStep(content: string): boolean {
  const line = lastNonEmptyLine(content);

  if (line === undefined) {
    return false;
  }

  const last = line.replace(/^[-*>\s]+/u, "").toLowerCase();

  if (last.endsWith("?")) {
    return false;
  }

  // The announcement is usually the last SENTENCE of a line of findings
  // ("This covers capacitor values. Let me record it."), so test that too.
  const sentences = last.split(/(?<=[.!])\s+/u);
  const sentence = sentences[sentences.length - 1] ?? last;

  return NEXT_STEP_RE.test(last) || NEXT_STEP_RE.test(sentence);
}
