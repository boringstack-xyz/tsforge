import { test, expect, afterEach } from "bun:test";
import {
  doLinearRead,
  doLinearWrite,
  doLinearStart,
  resolveLinearCapability,
  type ILinearDeps,
} from "../src/loop/tools/linear-ops";
import {
  lintHumanText,
  suppressCuratedSchemas,
  type IIntegrationRegistry,
} from "../src/loop/tools/integration-common";
import type { IToolContext } from "../src/loop/tools";

const ctx = (linear = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  linear,
});

/** A fake Linear MCP registry: routes `mcp__linear__<short>` to canned JSON, and
 *  records every call. Only the short names in `tools` are "exposed". */
function fakeRegistry(tools: Record<string, string>): {
  reg: IIntegrationRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const reg: IIntegrationRegistry = {
    has: (name) => Object.keys(tools).some((s) => name === `mcp__linear__${s}`),
    callTool: async (name, args) => {
      calls.push({ name, args });
      const short = name.replace("mcp__linear__", "");

      return tools[short] ?? "unknown MCP tool";
    },
  };

  return { reg, calls };
}

/** The keys each real Linear MCP tool accepts. The hosted server validates with
 *  `additionalProperties: false`, so any other key fails the whole call with
 *  "Unrecognized key". */
const STRICT_KEYS: Record<string, readonly string[]> = {
  save_issue: ["title", "description", "team", "id"],
  save_comment: ["body", "issueId", "id", "parentId"],
  list_comments: ["issueId", "cursor", "limit"],
  list_issues: ["query", "assignee", "team", "limit"],
  get_issue: ["id"],
};

/** A fake that rejects unknown keys the way the hosted Linear MCP does. */
function strictRegistry(tools: Record<string, string>): {
  reg: IIntegrationRegistry;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const { reg, calls } = fakeRegistry(tools);

  return {
    calls,
    reg: {
      has: (name) => reg.has(name),
      callTool: async (name, args) => {
        const allowed = STRICT_KEYS[name.replace("mcp__linear__", "")] ?? [];
        const bad = Object.keys(args).find((k) => !allowed.includes(k));

        if (bad !== undefined) {
          calls.push({ name, args });

          return `MCP tool ${name} failed: Unrecognized key: ${bad}`;
        }

        return reg.callTool(name, args);
      },
    },
  };
}

const deps = (
  reg: IIntegrationRegistry,
  run?: ILinearDeps["run"]
): ILinearDeps => ({
  registry: reg,
  run:
    run ??
    (async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false })),
});

afterEach(() => {
  delete process.env.TSFORGE_LINEAR_RAW;
  delete process.env.TSFORGE_NO_LINEAR;
});

test("read issue summarizes the card and surfaces the Linear branch name", async () => {
  const { reg, calls } = fakeRegistry({
    get_issue: JSON.stringify({
      identifier: "ENG-123",
      title: "Checkout is slow",
      state: "In Progress",
      branchName: "alex/eng-123-checkout-is-slow",
      url: "https://linear.app/x/issue/ENG-123",
      description: "Users wait too long at checkout.",
    }),
  });

  const out = await doLinearRead(
    { op: "issue", id: "ENG-123" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("ENG-123 Checkout is slow");
  expect(out).toContain("branch: alex/eng-123-checkout-is-slow");
  expect(out).toContain("Users wait too long");
  // called get_issue with the identifier
  expect(calls[0]?.args.id).toBe("ENG-123");
});

test("read tolerates a Linear MCP that uses a different create tool name", async () => {
  // Only `save_issue` exposed (claude.ai naming) — create must still resolve it.
  const { reg, calls } = fakeRegistry({
    save_issue: JSON.stringify({ identifier: "ENG-9", branchName: "x/eng-9" }),
  });

  const out = await doLinearWrite(
    { op: "create", title: "Add a retry to the flaky upload", team: "ENG" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("created ENG-9");
  expect(out).toContain("x/eng-9");
  expect(calls[0]?.name).toBe("mcp__linear__save_issue");
});

test("search lists matching issues compactly", async () => {
  const { reg } = fakeRegistry({
    list_issues: JSON.stringify([
      { identifier: "ENG-1", title: "First", state: "Todo" },
      { identifier: "ENG-2", title: "Second", state: "Done" },
    ]),
  });

  const out = await doLinearRead(
    { op: "search", query: "checkout" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("ENG-1 First [Todo]");
  expect(out).toContain("ENG-2 Second [Done]");
});

test("linear_start reads the card and checks out its branch", async () => {
  const { reg } = fakeRegistry({
    get_issue: JSON.stringify({
      identifier: "ENG-5",
      title: "Fix the thing",
      branchName: "alex/eng-5-fix-the-thing",
    }),
  });
  const ran: string[][] = [];

  const run: ILinearDeps["run"] = async (_cwd, argv) => {
    ran.push(argv);

    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };

  const out = await doLinearStart({ id: "ENG-5" }, ctx(), deps(reg, run));

  expect(out).toContain("on branch alex/eng-5-fix-the-thing for ENG-5");
  expect(ran[0]).toEqual(["git", "switch", "alex/eng-5-fix-the-thing"]);
});

test("linear_start creates the branch when switch fails (branch absent)", async () => {
  const { reg } = fakeRegistry({
    get_issue: JSON.stringify({ identifier: "ENG-6", branchName: "b/eng-6" }),
  });
  const ran: string[][] = [];

  const run: ILinearDeps["run"] = async (_cwd, argv) => {
    ran.push(argv);
    // first `switch` fails, then `switch -c` succeeds
    const failing = argv.length === 3 && argv[1] === "switch";

    return {
      stdout: "",
      stderr: failing ? "no such branch" : "",
      exitCode: failing ? 1 : 0,
      timedOut: false,
    };
  };

  await doLinearStart({ id: "ENG-6" }, ctx(), deps(reg, run));

  expect(ran[0]).toEqual(["git", "switch", "b/eng-6"]);
  expect(ran[1]).toEqual(["git", "switch", "-c", "b/eng-6"]);
});

test("write and start fail closed when the linear capability is off", async () => {
  const { reg, calls } = fakeRegistry({
    save_issue: "{}",
    get_issue: "{}",
  });

  const w = await doLinearWrite(
    { op: "create", title: "x" },
    ctx(false),
    deps(reg)
  );
  const s = await doLinearStart({ id: "ENG-1" }, ctx(false), deps(reg));

  expect(w).toContain("capability is off");
  expect(s).toContain("capability is off");
  // never touched the registry
  expect(calls.length).toBe(0);
});

test("create rejects a body that talks in line/file counts (human-intent lint)", async () => {
  const { reg, calls } = fakeRegistry({ create_issue: "{}" });

  const out = await doLinearWrite(
    {
      op: "create",
      title: "Refactor",
      description: "Changed 200 lines across 12 files.",
    },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("line/file counts");
  expect(calls.length).toBe(0);
});

test("create rejects an empty title", async () => {
  const { reg } = fakeRegistry({ create_issue: "{}" });

  expect(
    await doLinearWrite({ op: "create", title: "  " }, ctx(), deps(reg))
  ).toContain("empty");
});

test("a missing curated tool degrades to a clear message", async () => {
  const { reg } = fakeRegistry({}); // nothing exposed

  const out = await doLinearRead(
    { op: "issue", id: "ENG-1" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("exposes none of");
});

test("lintHumanText: intent passes; empty + mechanics are flagged", () => {
  expect(
    lintHumanText("Checkout is slow for large carts; make it feel instant.")
  ).toBeNull();
  expect(lintHumanText("")).toContain("empty");
  expect(lintHumanText("touched 5 files")).toContain("line/file");
});

test("resolveLinearCapability: on iff a `linear` server is connected + not killed", () => {
  expect(resolveLinearCapability({ serverNames: () => ["linear"] })).toBe(true);
  expect(resolveLinearCapability({ serverNames: () => ["notion"] })).toBe(
    false
  );
  expect(resolveLinearCapability(null)).toBe(false);
  expect(resolveLinearCapability(undefined)).toBe(false);

  process.env.TSFORGE_NO_LINEAR = "1";
  expect(resolveLinearCapability({ serverNames: () => ["linear"] })).toBe(
    false
  );
});

test("suppressCuratedSchemas drops a suppressed server's raw tools, keeps others", () => {
  const schemas = [
    {
      type: "function" as const,
      function: {
        name: "mcp__linear__list_issues",
        description: "",
        parameters: {},
      },
    },
    {
      type: "function" as const,
      function: {
        name: "mcp__notion__search",
        description: "",
        parameters: {},
      },
    },
  ];

  // no servers suppressed → passthrough
  expect(suppressCuratedSchemas(schemas, [])).toHaveLength(2);

  // suppress linear → its raw tools dropped, other servers kept
  const trimmed = suppressCuratedSchemas(schemas, ["linear"]);

  expect(trimmed.map((s) => s.function.name)).toEqual(["mcp__notion__search"]);
});

test("create sends `team` only — the hosted save_issue rejects `teamId`", async () => {
  const { reg, calls } = strictRegistry({
    save_issue: JSON.stringify({
      identifier: "TSF-40",
      branchName: "x/tsf-40",
    }),
  });

  const out = await doLinearWrite(
    { op: "create", title: "Wire the pickup selector", team: "TSF" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("created TSF-40");
  expect(calls[0]?.args).toEqual({
    title: "Wire the pickup selector",
    team: "TSF",
  });
});

test("create without a team fails before calling the server", async () => {
  const { reg, calls } = strictRegistry({ save_issue: "{}" });

  const out = await doLinearWrite(
    { op: "create", title: "Wire the pickup selector" },
    ctx(),
    deps(reg)
  );

  expect(out).toContain("needs a `team`");
  expect(calls.length).toBe(0);
});

test("comment targets the issue via issueId, never `id` (which edits a comment)", async () => {
  const { reg, calls } = strictRegistry({ save_comment: "{}" });

  const out = await doLinearWrite(
    { op: "comment", id: "TSF-20", body: "Tried the new wiring; hum is gone." },
    ctx(),
    deps(reg)
  );

  expect(out).toBe("commented on TSF-20");
  expect(calls[0]?.args).toEqual({
    issueId: "TSF-20",
    body: "Tried the new wiring; hum is gone.",
  });
});

test("comments read sends issueId only", async () => {
  const { reg, calls } = strictRegistry({
    list_comments: JSON.stringify([{ id: "c1", body: "hi" }]),
  });

  const out = await doLinearRead(
    { op: "comments", id: "TSF-20" },
    ctx(),
    deps(reg)
  );

  expect(out).not.toContain("Unrecognized key");
  expect(calls[0]?.args).toEqual({ issueId: "TSF-20" });
});

test("mine asks list_issues for assignee 'me' when list_my_issues is absent", async () => {
  const { reg, calls } = strictRegistry({
    list_issues: JSON.stringify({
      issues: [{ identifier: "TSF-31", title: "Mine", status: "Todo" }],
    }),
  });

  const out = await doLinearRead({ op: "mine" }, ctx(), deps(reg));

  expect(calls[0]?.args).toEqual({ assignee: "me" });
  // the hosted server wraps the list under `issues`
  expect(out).toContain("TSF-31 Mine [Todo]");
});
