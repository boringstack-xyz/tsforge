import { test, expect, describe, beforeEach } from "bun:test";
import {
  setBootHeadline,
  addBootChip,
  addBootNote,
  renderBootBanner,
  bootBannerEmpty,
  resetBootBanner,
} from "../src/cli/boot-banner";

beforeEach(() => {
  resetBootBanner();
});

/** Colour off keeps the assertions about LAYOUT, not escape codes. */
const plain = (cols: number): string[] =>
  renderBootBanner(cols, false).split("\n");

describe("boot banner", () => {
  test("nothing collected ⇒ empty string (no stray blank line)", () => {
    expect(bootBannerEmpty()).toBe(true);
    expect(renderBootBanner(80, false)).toBe("");
  });

  test("chip details line up in one column regardless of label length", () => {
    addBootChip("github", "on · git + PR review via gh");
    addBootChip("image", "read + generate · drag/@ to attach");
    addBootChip("delegation", "4 specialists · cap 4");

    const lines = plain(100);
    const at = (needle: string): number =>
      lines.find((l) => l.includes(needle))?.indexOf(needle) ?? -1;

    // Every detail starts at the same column — the old banner had 0 vs 2 space
    // indents and details that started wherever the label happened to end.
    expect(at("on · git")).toBe(at("read + generate"));
    expect(at("read + generate")).toBe(at("4 specialists"));
    expect(at("on · git")).toBeGreaterThan("delegation".length);
  });

  test("a long detail hang-indents to the value column, never to column 0", () => {
    addBootChip(
      "delegation",
      "4 specialists · cap 4 · explore, research, review-lens, verify"
    );

    const lines = plain(46).filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThan(1);

    const valueCol = lines[0]?.indexOf("4 specialists") ?? -1;

    expect(valueCol).toBeGreaterThan(0);

    // Continuation rows sit under the value column, so the phrase reads as a
    // block instead of snapping back to the left margin mid-sentence.
    for (const cont of lines.slice(1)) {
      expect(cont.search(/\S/u)).toBe(valueCol);
    }
  });

  test("the headline wraps too — it must not run past the pane either", () => {
    setBootHeadline("◆ plan mode", "reply approve to build, or keep exploring");

    for (const line of plain(40)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  test("no rendered row exceeds the pane width", () => {
    addBootChip(
      "delegation",
      "4 specialists · cap 4 · explore, research, review-lens, verify"
    );
    addBootChip("image", "read + generate · drag/@ to attach");
    addBootNote("MCP server 'sentry' failed to connect: spawn npx ENOENT");

    for (const line of plain(48)) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
  });

  test("headline comes first, with a blank line before the chips", () => {
    setBootHeadline("◆ plan mode", "reply approve to build");
    addBootChip("github", "on");

    const lines = plain(80);

    expect(lines[0]).toContain("◆ plan mode");
    expect(lines[0]).toContain("reply approve to build");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("github");
  });

  test("notes render below the chips and keep their text", () => {
    addBootChip("github", "on");
    addBootNote("⚠ no reviewModels configured — /review self-reviews");

    const body = renderBootBanner(80, false);
    const chipAt = body.indexOf("github");
    const noteAt = body.indexOf("no reviewModels");

    expect(noteAt).toBeGreaterThan(chipAt);
    expect(body).toContain("⚠ no reviewModels configured");
  });

  test("notes alone still render (a warning must never be swallowed)", () => {
    addBootNote("MCP server 'linear' failed to connect: timeout");

    expect(bootBannerEmpty()).toBe(false);
    expect(renderBootBanner(80, false)).toContain("failed to connect");
  });

  test("a trailing newline on a note doesn't open a gap", () => {
    addBootNote("loaded 3 agent specs\n");

    expect(renderBootBanner(80, false)).not.toContain("\n\n\n");
  });

  test("a very narrow pane still produces usable rows", () => {
    addBootChip("delegation", "4 specialists · cap 4");

    // Degenerate width: the value column alone would leave no room, so the
    // renderer floors the detail budget rather than looping or emitting "".
    const out = renderBootBanner(10, false);

    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("specialists");
  });

  test("reset clears everything (no leak between sessions)", () => {
    setBootHeadline("x", "y");
    addBootChip("a", "b");
    addBootNote("c");
    resetBootBanner();

    expect(bootBannerEmpty()).toBe(true);
    expect(renderBootBanner(80, false)).toBe("");
  });
});
