import type { IChatMessage, IModelResponse, IToolCall } from "../inference";

/**
 * History owns its tool-call args. Provider responses (and test `scripted()`
 * fixtures) must not share mutable argument objects with message history —
 * `scrubLegacyWriteArgStubs` (and other hygiene) may rewrite args in place,
 * which otherwise poisons the next run that reuses the same scripted step.
 */
function cloneToolCalls(calls: readonly IToolCall[]): IToolCall[] {
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: { ...tc.arguments },
  }));
}

/**
 * Keep the first occurrence of every line and drop the rest. Only applied to a
 * DEGENERATED reply: its tail is the loop itself ("Let me record this thread."
 * ×6), and replaying that verbatim hands the model the exact pattern it just
 * fell into — the retry reads its own stutter and continues it. The useful
 * part (findings written before the loop started) survives intact.
 */
export function collapseRepeatedLines(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    const key = line.trim();

    if (key.length > 0 && seen.has(key)) {
      continue;
    }

    if (key.length > 0) {
      seen.add(key);
    }

    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Build the assistant history message to record after a model call, carrying
 *  `reasoningContent` when the model produced it (DeepSeek's thinking mode requires it
 *  replayed on the next turn).
 *
 *  When a TTSR rule fired mid-stream the generation was ABORTED partway through — any
 *  `toolCalls` on the response are partial and never executed. Recording them would leave
 *  an assistant `tool_calls` message with no matching tool responses, which strict
 *  OpenAI-compatible APIs reject on the NEXT request ("An assistant message with
 *  'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
 *  e.g. DeepSeek's hosted API 400). A lenient local server tolerates it; a hosted one
 *  does not. So on a TTSR abort we drop the partial tool_calls and keep only the text
 *  (with a placeholder when it was empty, so the message is never both content-less and
 *  tool-less). The corrective guidance is appended separately as a user message by
 *  applyTtsrInterrupt. Shared by BOTH loops (Session.drive and runTask) so the two can't
 *  drift — a fix in one path but not the other left the bug live on the headless loop.
 *
 *  The SAME dangling-tool_calls shape exists on two more aborted paths and gets the
 *  same treatment: `degenerated` (the repetition guard cancelled the stream mid-call;
 *  the loop resteers WITHOUT executing the partial calls) and `truncated` (the
 *  response hit the token cap mid-JSON; the broken call was dropped and the loop
 *  steers with a smaller-call resteer). */
export function assistantMessage(res: IModelResponse): IChatMessage {
  const reasoning =
    res.reasoning === undefined ? {} : { reasoningContent: res.reasoning };

  if (
    res.ttsrFired !== undefined ||
    res.degenerated === true ||
    res.truncated === true
  ) {
    const content =
      res.degenerated === true
        ? collapseRepeatedLines(res.content)
        : res.content;
    const degenReasoning =
      res.degenerated === true && res.reasoning !== undefined
        ? { reasoningContent: collapseRepeatedLines(res.reasoning) }
        : reasoning;

    return {
      role: "assistant",
      content:
        content.length > 0
          ? content
          : "(generation interrupted before completion)",
      ...degenReasoning,
    };
  }

  return {
    role: "assistant",
    content: res.content,
    toolCalls: cloneToolCalls(res.toolCalls),
    ...reasoning,
  };
}
