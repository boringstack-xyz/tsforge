# tsforge monorepo

Single repository: `packages/core` (harness), `apps/docs` (Starlight site).

## Maintainer commands (repo root)

```bash
bun run ci:local                              # full CI mirror — run before every push (rules + arch + validate)
bun run validate                              # typecheck/lint/format/test/e2e (subset of ci:local)
bun test packages                             # full test suite (680+ tests)
tsforge                                       # run harness (after install or bun link)
bun run tsforge                               # run harness from monorepo checkout
bun run rules:build                           # regenerate RULES.md
bun run rules:check                           # fail if RULES.md has drifted
bun run rules:docs                            # regenerate rule-docs.generated.json
bun run arch:build                            # regenerate ARCHITECTURE.md (the subsystem map)
bun run arch:check                            # fail if ARCHITECTURE.md has drifted
bun run eval:sweep                            # A/B feature sweep (see tsforge.dev/eval/ab-testing/)
bun run eval:benchmark                        # compare edit mechanisms across runs
./scripts/audit-repo-settings.sh             # diff GitHub repo settings vs .github/desired-repo-settings.json
./scripts/release.sh patch                   # bump, tag, push → npm + GitHub Release (see .claude/skills/release/tsforge-release/)
```

## Layout

`packages/core/ARCHITECTURE.md` is the layout map: every subsystem with its purpose, size,
dependencies, mutual-dependency pairs, CLI entry points and adapter seams. It is generated
by `bun run arch:build` and drift-checked in CI, so it is never stale — read it instead of
a hand-kept table here.

Top level: `packages/core` (the harness), `apps/docs` (Astro Starlight site),
`packages/core/scripts/` (thin entry points — eval, sweep, doc generators).

To find the files behind a specific change, use
[Where do I change X?](https://tsforge.dev/internals/where-to-change/).

CI runs on every PR and push to `main` — see the workflow table in `CONTRIBUTING.md`.
`bun run ci:local` mirrors the core CI job (rules + arch drift + validate); run it
before every push. `bun run validate` alone is not enough — CI fails on ARCHITECTURE.md
/ RULES.md drift even when validate is green.

Remote: https://github.com/boringstack-xyz/tsforge

## House rules

- No `as` type assertions — narrow with guards
- No `eslint-disable` — fix the root cause
- Cyclomatic complexity ≤ 20
- Interfaces prefixed `I`; types live in `*.types.ts`
- No new logic file without a behavioral test sibling
- **A test is not coverage until it has failed.** Before claiming a line is
  tested, break it and watch the test go red. `expect(x).toBeDefined()` passes
  against `{}` as readily as against the value you meant, so an assertion that
  cannot fail proves nothing about the line beneath it.
- **Never describe a change you have not read back.** A scripted edit that
  matches nothing fails silently, so `grep` the new text before writing it into
  a commit message. Four commits in one session described fixes that were never
  in the file.
- **While the pane UI is up, only the renderer writes to the terminal.** A raw
  write paints over the frame; this leaked three times (jsdom warnings, library
  `console.error`, MCP servers' stderr). Show UI text through `echo`/`streamOut`,
  never `process.stdout.write`. Never let a child process inherit stdout/stderr:
  Bun.spawn's default stderr is `"inherit"`, so always set it (`"pipe"` and
  drain, or `"ignore"`). `TerminalGuard` diverts in-process strays at runtime;
  `tests/terminal-ownership.test.ts` rejects inheriting spawns;
  `scripts/e2e-terminal-ownership-pty.py` drives the real UI with noisy parts.
- **Scripts orchestrate; `src/` decides.** A file in `scripts/` is an entry
  point — parse args, call into `src/`, print. Any function it would be a bug to
  get wrong belongs in `src/`, where a test can import it. The graded score
  reached the acceptance rule for a week only in theory, because the merge step
  that dropped it sat in a script.
