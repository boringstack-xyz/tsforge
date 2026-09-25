import { test, expect } from "bun:test";
import {
  resolveInitialPlanMode,
  type IPlanModeArgs,
} from "../src/cli/plan-default";
import type { PolicyMode } from "../src/policy";

function args(over: Partial<IPlanModeArgs> = {}): IPlanModeArgs {
  return { plan: false, policyMode: "", ...over };
}

test("a fresh session with no flags defaults to plan mode", () => {
  expect(resolveInitialPlanMode(args(), undefined, "default")).toBe(true);
});

test("--plan forces plan mode on even against a non-plan base", () => {
  expect(resolveInitialPlanMode(args({ plan: true }), undefined, "ci")).toBe(
    true
  );
});

test("an explicit non-plan --policy-mode opts out", () => {
  expect(
    resolveInitialPlanMode(
      args({ policyMode: "default" }),
      undefined,
      "default"
    )
  ).toBe(false);
  expect(
    resolveInitialPlanMode(
      args({ policyMode: "acceptEdits" }),
      undefined,
      "acceptEdits"
    )
  ).toBe(false);
});

test("--policy-mode plan turns plan mode on", () => {
  expect(
    resolveInitialPlanMode(args({ policyMode: "plan" }), undefined, "plan")
  ).toBe(true);
});

test("a config policy.mode of non-plan (no CLI override) opts out", () => {
  const nonPlan: PolicyMode[] = [
    "acceptEdits",
    "ci",
    "dontAsk",
    "bypassPermissions",
  ];

  for (const mode of nonPlan) {
    expect(resolveInitialPlanMode(args(), undefined, mode)).toBe(false);
  }
});

test("a config policy.mode of plan (no CLI override) turns plan mode on", () => {
  expect(resolveInitialPlanMode(args(), undefined, "plan")).toBe(true);
});

test("a resumed session restores its saved posture, ignoring the default", () => {
  // Resumed OFF stays off even with a plan-first base.
  expect(resolveInitialPlanMode(args(), false, "default")).toBe(false);
  // Resumed ON stays on even with a non-plan base.
  expect(resolveInitialPlanMode(args(), true, "ci")).toBe(true);
});

test("resumed posture wins over --plan (the saved read-only guarantee)", () => {
  expect(resolveInitialPlanMode(args({ plan: true }), false, "default")).toBe(
    false
  );
});

// Plan-first exists to protect CODE from unreviewed edits. In a folder with no
// code (research notes, an empty dir) there is nothing to protect, and plan mode
// withholds `note` — the agent could only read, and "write this down" was
// answered with a plan-approval checklist. Start in normal mode there.
test("a fresh session in a folder with no code does not start in plan mode", () => {
  expect(resolveInitialPlanMode(args(), undefined, "default", false)).toBe(
    false
  );
});

test("an explicit request still wins in a no-code folder", () => {
  expect(
    resolveInitialPlanMode(args({ plan: true }), undefined, "default", false)
  ).toBe(true);
  expect(
    resolveInitialPlanMode(
      args({ policyMode: "plan" }),
      undefined,
      "default",
      false
    )
  ).toBe(true);
  expect(resolveInitialPlanMode(args(), true, "default", false)).toBe(true);
});

test("a folder with code keeps plan-first", () => {
  expect(resolveInitialPlanMode(args(), undefined, "default", true)).toBe(true);
});
