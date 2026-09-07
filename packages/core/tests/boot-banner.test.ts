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

/** The real session shape, so width assertions test something representative. */
const seedTypicalSession = (): void => {
  setBootHeadline("◆ plan mode", "approve to build");
  addBootChip("github", "git + PR review");
  addBootChip("image", "read + generate");
  addBootChip("delegation", "×4, cap 1");
};

describe("boot banner", () => {
  test("nothing collected ⇒ empty string (no stray blank line)", () => {
    expect(bootBannerEmpty()).toBe(true);
    expect(renderBootBanner(80, false)).toBe("");
  });

  test("capabilities share ONE line, not a row each", () => {
    seedTypicalSession();

    const body = renderBootBanner(120, false).trimEnd();

    // Headline + chips. The per-capability rows were the bulk of the old noise.
    expect(body.split("\n").length).toBe(2);
    expect(body).toContain(
      "github (git + PR review) · image (read + generate) · delegation (×4, cap 1)"
    );
  });

  test("a chip with no detail prints bare, with no empty parentheses", () => {
    addBootChip("linear");
    addBootChip("github", "git + PR review");

    const body = renderBootBanner(120, false);

    expect(body).toContain("linear · github (git + PR review)");
    expect(body).not.toContain("()");
  });

  test("wrapped rows hang-indent DEEPER than the first — never back to column 0", () => {
    // A note long enough to wrap at any sane width; the capability line itself
    // drops its parentheticals rather than wrapping, so it can't demonstrate this.
    addBootNote(
      "MCP server 'sentry' failed to connect: spawn npx ENOENT, and the retry timed out"
    );

    const lines = plain(34).filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThan(1); // it really did wrap

    const firstIndent = lines[0]?.search(/\S/u) ?? -1;

    expect(firstIndent).toBeGreaterThan(0);

    for (const cont of lines.slice(1)) {
      expect(cont.search(/\S/u)).toBeGreaterThan(firstIndent);
    }
  });

  test("no row exceeds the pane, at a NARROW pane (the reported case)", () => {
    // ~34 inner columns is a normal terminal at a large font — the width where
    // the previous aligned-column layout left ~20 columns for a value and
    // wrapped every one of them raggedly.
    seedTypicalSession();
    addBootNote("MCP server 'sentry' failed to connect: spawn npx ENOENT");

    for (const line of plain(34)) {
      expect(line.length).toBeLessThanOrEqual(34);
    }
  });

  test("no row exceeds the pane, at a wide pane", () => {
    seedTypicalSession();

    for (const line of plain(83)) {
      expect(line.length).toBeLessThanOrEqual(83);
    }
  });

  test("headline comes first and carries the instruction", () => {
    seedTypicalSession();

    const lines = plain(120);

    expect(lines[0]).toContain("◆ plan mode");
    expect(lines[0]).toContain("approve to build");
  });

  test("notes render below the chips, separated by a blank line", () => {
    addBootChip("github", "git + PR review");
    addBootNote("⚠ no reviewModels configured — /review self-reviews");

    const body = renderBootBanner(120, false);

    expect(body.indexOf("no reviewModels")).toBeGreaterThan(
      body.indexOf("github")
    );
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

  test("a degenerate width still produces readable rows", () => {
    seedTypicalSession();

    // Floored rather than looping or hard-breaking into single characters.
    expect(renderBootBanner(4, false)).toContain("plan mode");
  });

  test("reset clears everything (no leak between sessions)", () => {
    seedTypicalSession();
    addBootNote("c");
    resetBootBanner();

    expect(bootBannerEmpty()).toBe(true);
    expect(renderBootBanner(80, false)).toBe("");
  });
});
