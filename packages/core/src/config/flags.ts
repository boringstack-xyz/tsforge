import { FLAG_ON, ENV_FLAG } from "./config.constants";
import { DEFAULT_BRIDGE_PORT } from "../chrome-bridge/chrome-bridge.constants";

/**
 * The ONLY module that reads `process.env` for runtime flags. Read LIVE (on each
 * call, not at import) so per-run/test env changes take effect. (Scripts read
 * their own env directly — they're operational entry points, not library code.)
 */
function isOn(name: string): boolean {
  return process.env[name] === FLAG_ON;
}

export const flags = {
  /** Withhold the LSP nav tool set even on existing-code runs (A/B control). */
  noLspTools: (): boolean => isOn(ENV_FLAG.noLspTools),
  /** TDD-first mode: appends test-first guidance to the build prompt AND elevates
   *  the `test-sibling-required` meta-rule to an ERROR — so a logic file the agent
   *  TOUCHES without a test fails the gate (the harness obsesses over tests, not
   *  just suggests them). Quality + strictness out of the box, so DEFAULT ON; set
   *  TSFORGE_TDD=0 to opt out. The error is scoped to changed files (see the rule),
   *  so it never blocks on a repo's pre-existing untested code. */
  tdd: (): boolean => process.env.TSFORGE_TDD !== "0",
  /** Free, local web access (web_fetch + web_search) — opt-in (default OFF) so
   *  eval sweeps stay deterministic and offline. No key, no paid service:
   *  web_fetch extracts locally; web_search uses DuckDuckGo (or a self-hosted
   *  SearXNG via TSFORGE_SEARXNG_URL). */
  webTools: (): boolean => isOn(ENV_FLAG.webTools),
  /** Chrome research bridge — opt-in (default OFF). Starts the localhost bridge
   *  the tsforge extension connects to and advertises the browser_* tools. */
  browser: (): boolean => isOn(ENV_FLAG.browser),
  /** Bridge port (1024–65535); anything else falls back to the default. */
  browserPort: (): number => {
    const n = Number(process.env[ENV_FLAG.browserPort]);

    return Number.isInteger(n) && n >= 1024 && n <= 65_535
      ? n
      : DEFAULT_BRIDGE_PORT;
  },
  /** Let the browser tools open private / loopback hosts (intranet research).
   *  Off by default so injected page text can't aim the logged-in browser at a
   *  router, an internal service, or the bridge itself. */
  browserAllowPrivate: (): boolean => isOn(ENV_FLAG.browserAllowPrivate),
  /** Programmatic Tool Calling: advertise the `script` tool. ON by default — it
   *  measurably speeds up read-dependent multi-file work (codemods) and is a no-op
   *  on simple tasks; withhold with TSFORGE_NO_SCRIPT (the A/B / kill switch). It
   *  makes no network calls, so default-on keeps eval sweeps deterministic. */
  scriptTool: (): boolean => !isOn(ENV_FLAG.noScriptTool),
  /** Withhold the read-only `git_context` tool on existing-code runs (default ON;
   *  set to "1" to force off, e.g. for eval sweeps or non-git workspaces). */
  noGitTool: (): boolean => isOn(ENV_FLAG.noGitTool),
  /** Kill-switch for the whole `github` capability (the git_write / github_read /
   *  github_write tools). The capability is otherwise auto-detected (on iff the
   *  `gh` CLI is installed AND authenticated); set TSFORGE_NO_GITHUB=1 to force it
   *  off (A/B control, or to keep a run purely local). */
  noGithub: (): boolean => isOn(ENV_FLAG.noGithub),
  /** Kill-switch for the `linear` capability (the linear_read / linear_write /
   *  linear_start verbs). The capability is otherwise on iff a `linear` MCP server
   *  is configured AND connected; set TSFORGE_NO_LINEAR=1 to force it off. */
  noLinear: (): boolean => isOn(ENV_FLAG.noLinear),
  /** Re-expose the RAW `mcp__linear__*` tools alongside the curated verbs. Off by
   *  default: when the linear capability is on, the raw Linear MCP tools are
   *  suppressed from advertisement (still dispatchable) so the model's tool list
   *  stays small. Set TSFORGE_LINEAR_RAW=1 for full passthrough. */
  linearRaw: (): boolean => isOn(ENV_FLAG.linearRaw),
  /** Kill-switch for the `notion` capability (notion_read / notion_write); on iff a
   *  `notion` MCP server is configured + connected. */
  noNotion: (): boolean => isOn(ENV_FLAG.noNotion),
  /** Re-expose the raw `mcp__notion__*` tools alongside the curated verbs. */
  notionRaw: (): boolean => isOn(ENV_FLAG.notionRaw),
  /** Kill-switch for the `sentry` capability (sentry_read / sentry_write); on iff a
   *  `sentry` MCP server is configured + connected. */
  noSentry: (): boolean => isOn(ENV_FLAG.noSentry),
  /** Re-expose the raw `mcp__sentry__*` tools alongside the curated verbs. */
  sentryRaw: (): boolean => isOn(ENV_FLAG.sentryRaw),
  /** Kill-switch for the post-work agent review phase (auto review after a task
   *  goes green). On by default; set TSFORGE_NO_REVIEW=1 to skip it — used by eval
   *  sweeps (determinism/cost) and any run that doesn't want the extra pass. */
  noReview: (): boolean => isOn(ENV_FLAG.noReview),
  /** Fall back to basic readline input (no multiline editor) in interactive mode.
   *  Default OFF — the editor is on. Set to "1" to disable the editor. */
  basicInput: (): boolean => isOn(ENV_FLAG.basicInput),
  /** Withhold model-driven delegation (the `spawn_agent` tool + specialists).
   *  Default OFF — delegation is on. Set to "1" for the A/B control arm (measure
   *  the harness WITHOUT subagents) or to force a pure single-stream run. */
  noDelegation: (): boolean => isOn(ENV_FLAG.noDelegation),
  /** Enable the EXPERT HANDOFF: when a build stalls after the full steering ladder,
   *  hand the blocking file to the configured `capabilities.expert` model. Opt-in
   *  (default OFF) because it makes a live, paid, non-deterministic API call — so
   *  unit tests and eval sweeps that drive a run to a stall never hit it unless they
   *  explicitly ask. Real autonomous builders (the headless web builder, interactive
   *  sessions) turn it on. Without it, a stall parks with all work kept, as before. */
  expertRescue: (): boolean => isOn(ENV_FLAG.expertRescue),
  /** WS-B near-green checkpoint/rollback: when the build reaches a near-green low (1..N
   *  errors) snapshot the scope files, and if the next gate SPRAYS past it (curr >
   *  checkpoint + M) revert to that best instead of letting the model build on the
   *  regression. DEFAULT ON — it's the fix for the near-green oscillation that thrashes real
   *  builds (Phase 0a), and it's deterministic (no network), so every build should get it
   *  without knowing a flag exists. Kill-switch TSFORGE_NO_NEAR_GREEN_CHECKPOINT=1 disables
   *  it (A/B control / escape hatch). Thresholds N=2, M=3 from Phase 0a. */
  nearGreenCheckpoint: (): boolean => !isOn(ENV_FLAG.noNearGreenCheckpoint),
  /** WS-B near-green ROTATION steer (#77): when the build sits at a near-green count but the
   *  SPECIFIC error set rotates for several cycles (the model fixes one error and the fix spawns
   *  another — e.g. extracts a component → its siblings/tests are now missing), inject a
   *  completion-only steer ("finish the files that already have errors; don't create new
   *  files/modules unless the same edit adds their siblings + tests"). This is the last-mile gap
   *  that made green non-deterministic (build17 parked on it; build16 crossed by luck). Count-only
   *  WS-B can't see it (the count never sprays). DEFAULT ON, deterministic (no network); kill with
   *  TSFORGE_NO_NEAR_GREEN_ROTATION=1. Generic — keyed only on rule/file, no stack knowledge. */
  nearGreenRotation: (): boolean => !isOn(ENV_FLAG.noNearGreenRotation),
  /** OSC 8 file:line hyperlinks in the TUI (gate rail + transcript). Off when
   *  TSFORGE_NO_OSC8=1 or stdout is not a TTY. */
  osc8Links: (): boolean => !isOn(ENV_FLAG.noOsc8) && process.stdout.isTTY,
};
