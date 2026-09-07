/**
 * The session-start banner.
 *
 * Two lines, not a table:
 *
 *   ◆ plan mode · reply approve to build
 *   github · image (read + generate) · delegation ×4, cap 1
 *
 * An aligned label/detail column was tried and dropped. It reads well on a wide
 * pane and badly on a narrow one: the label column is fixed overhead, so on a
 * ~34-column main pane (a normal terminal at a large font) it left ~20 columns
 * for the value and every detail wrapped raggedly. Capabilities are a short
 * list, so a flowing `·`-separated line costs one row instead of one row each
 * and degrades gracefully — a narrow pane simply wraps it with a hanging indent.
 *
 * Facts are COLLECTED here and formatted at seed time, when the pane can finally
 * say how wide the transcript column is. Formatting earlier is what produced the
 * original mess: lines pre-rendered blind at boot with hand-typed indents, so
 * nothing lined up and long ones wrapped back to column 0.
 */
import { STYLE, paint } from "../render/style";
import { wrapToWidth } from "../render/ansi";

let headline: { label: string; detail: string } | null = null;
const chips: { label: string; detail: string }[] = [];
const notes: string[] = [];

const INDENT = "  ";
const HANG = "    ";
/** Never wrap narrower than this, however cramped the pane. */
const MIN_COLS = 16;

/** The mode line (e.g. plan mode), printed first. Stored as label + plain body
 *  rather than a pre-painted string: `displayWidth` counts escape bytes, so a
 *  painted headline cannot be wrapped correctly, and an unwrapped one is what
 *  the pane then re-wrapped back to column 0. */
export function setBootHeadline(label: string, body: string): void {
  headline = { label, detail: body };
}

/** One capability, joined into the single `·`-separated line. `detail` is the
 *  parenthetical — omit it when the name alone says everything. */
export function addBootChip(label: string, detail = ""): void {
  chips.push({ label, detail });
}

/** A free-form line (warnings, loader messages) shown below the chips. */
export function addBootNote(text: string): void {
  notes.push(text.replace(/\n+$/u, ""));
}

/** Drop everything collected. The pane path calls this after seeding, without
 *  which the stdout flush would render the whole banner a SECOND time. */
export function resetBootBanner(): void {
  headline = null;
  chips.length = 0;
  notes.length = 0;
}

/** True when nothing was collected, so the caller can skip the blank line. */
export function bootBannerEmpty(): boolean {
  return headline === null && chips.length === 0 && notes.length === 0;
}

/** Wrap one logical line to the pane: first row at `INDENT`, the rest hanging
 *  at `HANG` so a wrapped value never snaps back to column 0. Painting happens
 *  per row, AFTER wrapping, so escape bytes can't skew the width measurement. */
function block(
  text: string,
  cols: number,
  style: string,
  color: boolean
): string[] {
  const width = Math.max(MIN_COLS, cols - INDENT.length);
  const [first = "", ...rest] = wrapToWidth(text, width);

  return [
    `${INDENT}${paint(first, style, color)}`,
    ...rest.map((line) => `${HANG}${paint(line, style, color)}`),
  ];
}

/** The capability line. Details ride in parentheses when the whole line fits on
 *  one row; on a pane too narrow for that they are dropped and the names stand
 *  alone, because three wrapped rows of parentheticals is the "wall of text" this
 *  banner is meant to avoid. The names are what a reader scans for; the details
 *  are a nicety, and /help has them either way. */
function chipLine(cols: number): string {
  const full = chips
    .map((c) => (c.detail.length === 0 ? c.label : `${c.label} (${c.detail})`))
    .join(" · ");

  return full.length <= cols - INDENT.length
    ? full
    : chips.map((c) => c.label).join(" · ");
}

/** Render the banner for a transcript `cols` wide. */
export function renderBootBanner(cols: number, color: boolean): string {
  if (bootBannerEmpty()) {
    return "";
  }

  const width = Math.max(MIN_COLS, cols);
  const lines: string[] = [];

  if (headline !== null) {
    lines.push(
      ...block(
        `${headline.label} · ${headline.detail}`,
        width,
        STYLE.plan,
        color
      )
    );
  }

  if (chips.length > 0) {
    lines.push(...block(chipLine(width), width, STYLE.dim, color));
  }

  if (notes.length > 0) {
    lines.push("");

    for (const note of notes) {
      lines.push(...block(note, width, STYLE.dim, color));
    }
  }

  return `${lines.join("\n")}\n`;
}
