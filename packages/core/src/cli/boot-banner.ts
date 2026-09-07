/**
 * The session-start banner.
 *
 * Boot facts are COLLECTED as structured values and formatted once, at seed
 * time, when the pane console can finally say how wide the transcript column
 * is. Formatting them earlier is what made the old banner ugly: each line was
 * pre-rendered at boot with a hand-typed two-space indent, so labels didn't
 * line up and any line past the pane's width wrapped back to column 0,
 * splitting "reply approve to build" and "(explore, research, review-lens,
 * verify)" mid-phrase.
 *
 * Free-form notes (MCP connect results, agent-spec loader messages, config
 * warnings) keep their own text and are printed under the chips.
 */
import { STYLE, paint } from "../render/style";
import { wrapToWidth } from "../render/ansi";

/** One aligned `label  detail` row. */
interface IBootChip {
  label: string;
  detail: string;
  /** Label styling; the headline uses the brand accent, chips the chrome tint. */
  labelStyle?: string;
}

let headline: IBootChip | null = null;
const chips: IBootChip[] = [];
const notes: string[] = [];

/** The mode line, printed first (e.g. plan mode). Stored as label + plain body
 *  rather than a pre-painted string: `displayWidth` counts escape bytes, so a
 *  painted headline cannot be wrapped correctly, and an unwrapped one is what
 *  the pane then re-wrapped back to column 0. */
export function setBootHeadline(label: string, body: string): void {
  headline = { label, detail: body, labelStyle: STYLE.plan + STYLE.bold };
}

/** An aligned capability row: `github` / `on · git + PR review via gh`. */
export function addBootChip(label: string, detail: string): void {
  chips.push({ label, detail });
}

/** A free-form line (warnings, loader messages) shown below the chips. */
export function addBootNote(text: string): void {
  notes.push(text.replace(/\n+$/u, ""));
}

/** Drop everything collected — used by tests and by a second boot in-process. */
export function resetBootBanner(): void {
  headline = null;
  chips.length = 0;
  notes.length = 0;
}

/** True when nothing has been collected (so the caller can skip the blank line). */
export function bootBannerEmpty(): boolean {
  return headline === null && chips.length === 0 && notes.length === 0;
}

const INDENT = "  ";
const GAP = 2;
/** Below this many columns for the detail, the aligned layout stops helping. */
const MIN_DETAIL_COLS = 16;

/** One chip, aligned: `label` padded to a shared column, detail wrapped with a
 *  hanging indent so continuation rows sit under the detail, not at column 0. */
function alignedChip(
  chip: IBootChip,
  labelWidth: number,
  detailWidth: number,
  color: boolean
): string[] {
  const valueCol = INDENT.length + labelWidth + GAP;
  const label = paint(
    chip.label.padEnd(labelWidth, " "),
    STYLE.chromeLight,
    color
  );
  const [first = "", ...rest] = wrapToWidth(chip.detail, detailWidth);
  const out = [
    `${INDENT}${label}${" ".repeat(GAP)}${paint(first, STYLE.dim, color)}`,
  ];

  for (const cont of rest) {
    out.push(`${" ".repeat(valueCol)}${paint(cont, STYLE.dim, color)}`);
  }

  return out;
}

/** One chip on a pane too narrow to align: detail stacked under its label,
 *  which beats hard-breaking words mid-syllable ("speciali/sts"). */
function stackedChip(chip: IBootChip, cols: number, color: boolean): string[] {
  const width = Math.max(MIN_DETAIL_COLS, cols - INDENT.length - GAP);
  const out = [
    `${INDENT}${paint(chip.label, chip.labelStyle ?? STYLE.chromeLight, color)}`,
  ];

  for (const line of wrapToWidth(chip.detail, width)) {
    out.push(`${INDENT}${" ".repeat(GAP)}${paint(line, STYLE.dim, color)}`);
  }

  return out;
}

function renderChips(cols: number, color: boolean): string[] {
  const labelWidth = Math.max(...chips.map((c) => c.label.length));
  const detailWidth = cols - (INDENT.length + labelWidth + GAP);
  const stacked = detailWidth < MIN_DETAIL_COLS;

  return chips.flatMap((chip) =>
    stacked
      ? stackedChip(chip, cols, color)
      : alignedChip(chip, labelWidth, detailWidth, color)
  );
}

function renderNotes(cols: number, color: boolean): string[] {
  const width = Math.max(MIN_DETAIL_COLS, cols - INDENT.length);

  return notes.flatMap((note) =>
    wrapToWidth(note, width).map(
      (line) => `${INDENT}${paint(line, STYLE.dim, color)}`
    )
  );
}

/**
 * Render the banner for a transcript `cols` wide.
 *
 * Width is the pane's inner width, so this is the one place that knows how much
 * room there actually is — which is exactly why formatting happens here and not
 * at boot, where the old banner was pre-rendered blind and wrapped to column 0.
 */
export function renderBootBanner(cols: number, color: boolean): string {
  if (bootBannerEmpty()) {
    return "";
  }

  const lines: string[] = [];

  if (headline !== null) {
    const width = Math.max(
      MIN_DETAIL_COLS,
      cols - (INDENT.length + headline.label.length + GAP)
    );

    lines.push(...alignedChip(headline, headline.label.length, width, color));
  }

  if (chips.length > 0) {
    if (headline !== null) {
      lines.push("");
    }

    lines.push(...renderChips(cols, color));
  }

  if (notes.length > 0) {
    lines.push("");
    lines.push(...renderNotes(cols, color));
  }

  return `${lines.join("\n")}\n`;
}
