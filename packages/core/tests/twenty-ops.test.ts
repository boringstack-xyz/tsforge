import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  doTwentyRead,
  doTwentyWrite,
  recordLine,
  resolveTwentyCapability,
  twentyError,
  type ITwentyDeps,
} from "../src/loop/tools/twenty-ops";
import { isRecord } from "../src/loop/tools/integration-common";
import type { IToolContext } from "../src/loop/tools";
import type { IIntegrationRegistry } from "../src/loop/tools/integration-common";

/** Twenty v2.41's real input schemas (learn_tools output) for every inner tool
 *  the verbs call. The fake below validates each call against them, so a wrong
 *  field name, a missing `select`/`position` or a bad enum fails here exactly as
 *  it would against the live server. */
const FIXTURE: unknown = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "twenty-schemas.json"), "utf8")
);
const SCHEMAS: Record<string, Record<string, unknown>> = isRecord(FIXTURE) &&
isRecord(FIXTURE.tools)
  ? Object.fromEntries(
      Object.entries(FIXTURE.tools).filter(
        (e): e is [string, Record<string, unknown>] => isRecord(e[1])
      )
    )
  : {};

/** Each object's real field names (find_one_<x> select ["*"] on the live
 *  server). Twenty checks `select` names at runtime, which no schema expresses. */
const FIELDS: Record<string, readonly string[]> =
  isRecord(FIXTURE) && isRecord(FIXTURE.fields)
    ? Object.fromEntries(
        Object.entries(FIXTURE.fields).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? v.filter((f): f is string => typeof f === "string")
            : [],
        ])
      )
    : {};

/** find_many_people → person, find_one_task → task, find_many_note_targets → note_target. */
const OBJECT_OF: Record<string, string> = {
  people: "person",
  companies: "company",
  opportunities: "opportunity",
  tasks: "task",
  notes: "note",
  note_targets: "note_target",
  task_targets: "task_target",
};

function selectErrors(tool: string, args: Record<string, unknown>): string[] {
  const m = /^find_(?:many|one)_(.+)$/u.exec(tool);

  if (m === null || !Array.isArray(args.select)) {
    return [];
  }

  const object = OBJECT_OF[m[1] ?? ""] ?? m[1] ?? "";
  const known = FIELDS[object];

  if (known === undefined) {
    return [];
  }

  return args.select
    .filter((f) => f !== "*" && !(typeof f === "string" && known.includes(f)))
    .map((f) => `Object ${object} doesn't have any "${String(f)}" field.`);
}

// ── a small JSON-schema checker, strict about unknown fields like Twenty ──────

function resolve(
  schema: Record<string, unknown>,
  defs: Record<string, unknown>
): Record<string, unknown> {
  const ref = schema.$ref;

  if (typeof ref === "string") {
    const target = defs[ref.replace("#/$defs/", "")];

    return isRecord(target) ? resolve(target, defs) : {};
  }

  return schema;
}

function typeOk(type: unknown, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isRecord(v);
    case "null":
      return v === null;
    default:
      return true;
  }
}

function check(
  v: unknown,
  raw: Record<string, unknown>,
  defs: Record<string, unknown>,
  path: string
): string[] {
  const s = resolve(raw, defs);

  if (Array.isArray(s.anyOf)) {
    const ok = s.anyOf.some(
      (alt) => isRecord(alt) && check(v, alt, defs, path).length === 0
    );

    return ok ? [] : [`${path}: matches no allowed shape`];
  }

  const types = Array.isArray(s.type) ? s.type : [s.type];

  if (s.type !== undefined && !types.some((t) => typeOk(t, v))) {
    return [`${path}: expected ${JSON.stringify(s.type)}`];
  }

  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    return [`${path}: not one of ${JSON.stringify(s.enum)}`];
  }

  if ("const" in s && s.const !== v) {
    return [`${path}: must be ${JSON.stringify(s.const)}`];
  }

  if (
    s.format === "uri" &&
    typeof v === "string" &&
    !/^[a-z]+:\/\//iu.test(v)
  ) {
    return [`${path}: not a uri`];
  }

  if (
    s.format === "date-time" &&
    typeof v === "string" &&
    Number.isNaN(Date.parse(v))
  ) {
    return [`${path}: not a date-time`];
  }

  if (Array.isArray(v)) {
    const errs: string[] = [];

    if (typeof s.minItems === "number" && v.length < s.minItems) {
      errs.push(`${path}: needs at least ${String(s.minItems)} item(s)`);
    }

    if (isRecord(s.items)) {
      const items = s.items;

      v.forEach((x, i) =>
        errs.push(...check(x, items, defs, `${path}[${String(i)}]`))
      );
    }

    return errs;
  }

  if (!isRecord(v)) {
    return [];
  }

  const props = isRecord(s.properties) ? s.properties : {};
  const errs: string[] = [];

  for (const req of Array.isArray(s.required) ? s.required : []) {
    if (typeof req === "string" && !(req in v)) {
      errs.push(`${path}.${req}: required`);
    }
  }

  for (const [k, x] of Object.entries(v)) {
    const p = props[k];

    if (isRecord(p)) {
      errs.push(...check(x, p, defs, `${path}.${k}`));
    } else if (isRecord(s.additionalProperties)) {
      errs.push(...check(x, s.additionalProperties, defs, `${path}.${k}`));
    } else if (
      Object.keys(props).length > 0 ||
      s.additionalProperties === false
    ) {
      // Twenty: "Object person doesn't have any \"x\" field."
      errs.push(`${path}.${k}: unknown field`);
    }
  }

  return errs;
}

/** Validate one execute_tool call the way Twenty would. */
function validate(tool: string, args: Record<string, unknown>): string[] {
  const schema = SCHEMAS[tool];

  if (schema === undefined) {
    return [`Tool "${tool}" not found`];
  }

  const defs = isRecord(schema.$defs) ? schema.$defs : {};

  return [...check(args, schema, defs, tool), ...selectErrors(tool, args)];
}

// ── fake registry ───────────────────────────────────────────────────────────

interface IExec {
  tool: string;
  args: Record<string, unknown>;
}

type Reply =
  | Record<string, unknown>
  | ((args: Record<string, unknown>) => Record<string, unknown>);
type Replies = Record<string, Reply>;

const UUID = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeTwenty(replies: Replies): { deps: ITwentyDeps; execs: IExec[] } {
  const execs: IExec[] = [];
  const reg: IIntegrationRegistry = {
    has: (name) => name === "mcp__twenty__execute_tool",
    callTool: async (name, raw) => {
      expect(name).toBe("mcp__twenty__execute_tool");
      // the outer execute_tool schema: exactly {toolName, arguments}
      expect(Object.keys(raw).sort()).toEqual(["arguments", "toolName"]);

      const tool = typeof raw.toolName === "string" ? raw.toolName : "";
      const args = isRecord(raw.arguments) ? raw.arguments : {};

      execs.push({ tool, args });

      const errors = validate(tool, args);

      if (errors.length > 0) {
        return `MCP tool '${name}' failed: ${JSON.stringify({ success: false, message: "invalid", error: errors.join("; ") })}`;
      }

      const reply = replies[tool];
      const result = typeof reply === "function" ? reply(args) : reply;

      return JSON.stringify({
        success: true,
        message: "ok",
        result: result ?? { records: [], count: "0", hasNextPage: false },
      });
    },
  };

  return { deps: { registry: reg }, execs };
}

const ctx = (twenty = true): IToolContext => ({
  cwd: "/repo",
  files: [],
  report: () => {},
  task: "t",
  twenty,
});

/** A write must never surface a schema error from the fake. */
function noSchemaError(out: string): void {
  expect(out).not.toContain("doesn't have any");
  expect(out).not.toContain("unknown field");
  expect(out).not.toContain("required");
  expect(out).not.toContain("not one of");
  expect(out).not.toContain("matches no allowed shape");
}

const PERSON = {
  id: UUID(1),
  name: { firstName: "Ada", lastName: "Example" },
  emails: { primaryEmail: "ada@example.test", additionalEmails: [] },
  jobTitle: "CTO",
  company: {
    id: UUID(2),
    name: "Example Co",
    domainName: { primaryLinkUrl: "example.test" },
  },
};

// ── fixture sanity ──────────────────────────────────────────────────────────

test("the fixture covers every inner tool the verbs call", () => {
  for (const t of [
    "find_many_people",
    "find_many_companies",
    "find_many_opportunities",
    "find_many_tasks",
    "find_many_notes",
    "find_one_person",
    "find_one_company",
    "find_one_opportunity",
    "find_one_task",
    "find_one_note",
    "create_one_person",
    "create_one_company",
    "create_one_opportunity",
    "create_one_note",
    "create_one_task",
    "create_one_note_target",
    "create_one_task_target",
    "update_one_person",
    "update_one_company",
    "update_one_opportunity",
    "find_many_note_targets",
    "find_many_task_targets",
    "group_by_opportunities",
  ]) {
    expect(SCHEMAS[t]).toBeDefined();
  }
});

test("the checker itself rejects what Twenty rejects", () => {
  expect(validate("find_many_people", { limit: 1 })).toContain(
    "find_many_people.select: required"
  );
  expect(
    validate("find_many_people", { select: ["id"], bogusKey: 1 })[0]
  ).toContain("unknown field");
  expect(
    validate("create_one_opportunity", { stage: "LOST", position: "first" })[0]
  ).toContain("not one of");
  expect(validate("create_one_person", { name: { firstName: "A" } })).toContain(
    "create_one_person.position: required"
  );
  expect(
    validate("create_one_company", {
      position: "first",
      domainName: { primaryLinkUrl: "acme.com" },
    })[0]
  ).toContain("not a uri");
  expect(validate("find_many_persons", {})).toEqual([
    'Tool "find_many_persons" not found',
  ]);
  expect(
    validate("find_one_task", { id: UUID(1), select: ["id", "dueDate"] })
  ).toEqual(['Object task doesn\'t have any "dueDate" field.']);
  expect(Object.keys(FIELDS).sort()).toEqual([
    "company",
    "note",
    "note_target",
    "opportunity",
    "person",
    "task",
    "task_target",
  ]);
});

// ── reads ───────────────────────────────────────────────────────────────────

test("search people: valid filter on names + email, compact rows with ids", async () => {
  const { deps, execs } = fakeTwenty({
    find_many_people: { records: [PERSON], count: "1", hasNextPage: false },
  });

  const out = await doTwentyRead(
    { op: "search", type: "person", query: "ada" },
    ctx(),
    deps
  );

  expect(execs[0]?.tool).toBe("find_many_people");
  expect(execs[0]?.args.or).toEqual([
    { name: { firstName: { ilike: "%ada%" } } },
    { name: { lastName: { ilike: "%ada%" } } },
    { emails: { primaryEmail: { ilike: "%ada%" } } },
  ]);
  expect(out).toContain(
    `Ada Example · ada@example.test · CTO · Example Co  (${UUID(1)})`
  );
});

for (const type of [
  "person",
  "company",
  "opportunity",
  "task",
  "note",
] as const) {
  test(`list + search ${type}: arguments pass Twenty's schema`, async () => {
    const { deps, execs } = fakeTwenty({});

    const list = await doTwentyRead(
      { op: "list", type, limit: 99 },
      ctx(),
      deps
    );
    const search = await doTwentyRead(
      { op: "search", type, query: "x" },
      ctx(),
      deps
    );

    noSchemaError(list);
    noSchemaError(search);
    expect(execs).toHaveLength(2);
    expect(execs[0]?.args.limit).toBe(50); // clamped
  });

  test(`record ${type}: arguments pass Twenty's schema`, async () => {
    const { deps } = fakeTwenty({});

    noSchemaError(
      await doTwentyRead({ op: "record", type, id: UUID(1) }, ctx(), deps)
    );
  });
}

test("type aliases (people, deal, contact) resolve", async () => {
  const { deps, execs } = fakeTwenty({});

  await doTwentyRead({ op: "list", type: "people" }, ctx(), deps);
  await doTwentyRead({ op: "list", type: "deal" }, ctx(), deps);
  await doTwentyRead({ op: "list", type: "Contact" }, ctx(), deps);
  expect(execs.map((e) => e.tool)).toEqual([
    "find_many_people",
    "find_many_opportunities",
    "find_many_people",
  ]);
});

test("record person: detail plus attached notes and tasks", async () => {
  const { deps, execs } = fakeTwenty({
    find_one_person: {
      records: [
        {
          ...PERSON,
          phones: {
            primaryPhoneNumber: "5550100",
            primaryPhoneCallingCode: "+1",
          },
        },
      ],
    },
    find_many_note_targets: {
      records: [{ id: UUID(9), note: { id: UUID(3), title: "Call recap" } }],
    },
    find_many_task_targets: {
      records: [{ id: UUID(8), task: { id: UUID(4), title: "Send quote" } }],
    },
  });

  const out = await doTwentyRead(
    { op: "record", type: "person", id: UUID(1) },
    ctx(),
    deps
  );

  expect(out).toContain("phone: +15550100");
  expect(out).toContain(`notes:\n- Call recap  (${UUID(3)})`);
  expect(out).toContain(`tasks:\n- Send quote  (${UUID(4)})`);
  expect(
    execs.find((e) => e.tool === "find_many_note_targets")?.args.targetPersonId
  ).toEqual({ eq: UUID(1) });
});

test("record with a non-UUID id is refused locally", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyRead({ op: "record", type: "person", id: "Ada" }, ctx(), deps)
  ).toContain("a UUID");
  expect(execs).toHaveLength(0);
});

test("pipeline reads Twenty's real group_by shape ({dimensions, value})", async () => {
  const { deps, execs } = fakeTwenty({
    group_by_opportunities: (args: Record<string, unknown>) =>
      args.aggregateOperation === "SUM"
        ? {
            groups: [
              { dimensions: ["PROPOSAL"], value: "1234000000" },
              { dimensions: ["NEW"], value: "0" },
            ],
          }
        : {
            groups: [
              { dimensions: ["NEW"], value: "2" },
              { dimensions: ["PROPOSAL"], value: "1" },
            ],
          },
  });

  const out = await doTwentyRead({ op: "pipeline" }, ctx(), deps);

  expect(execs).toHaveLength(2);
  expect(out).toBe(
    "opportunities by stage (count · total amount):\nNEW: 2\nPROPOSAL: 1 · 1,234"
  );
});

test("pipeline with no deals says so", async () => {
  const { deps } = fakeTwenty({ group_by_opportunities: { groups: [] } });

  expect(await doTwentyRead({ op: "pipeline" }, ctx(), deps)).toBe(
    "no opportunities yet"
  );
});

// ── writes ──────────────────────────────────────────────────────────────────

test("create person maps friendly fields to Twenty's composite shapes", async () => {
  const { deps, execs } = fakeTwenty({ create_one_person: { id: UUID(5) } });

  const out = await doTwentyWrite(
    {
      op: "create",
      type: "person",
      firstName: "Ada",
      lastName: "Example",
      email: "ada@example.test",
      phone: "5550100",
      jobTitle: "CTO",
      companyId: UUID(2),
    },
    ctx(),
    deps
  );

  expect(out).toBe(`created person ${UUID(5)}`);
  expect(execs[0]?.args).toEqual({
    name: { firstName: "Ada", lastName: "Example" },
    emails: { primaryEmail: "ada@example.test" },
    phones: { primaryPhoneNumber: "5550100" },
    jobTitle: "CTO",
    companyId: UUID(2),
    position: "first",
  });
});

test("create company turns a bare domain into a URL Twenty accepts", async () => {
  const { deps, execs } = fakeTwenty({ create_one_company: { id: UUID(6) } });

  noSchemaError(
    await doTwentyWrite(
      { op: "create", type: "company", name: "Acme", domain: "acme.com" },
      ctx(),
      deps
    )
  );
  expect(execs[0]?.args.domainName).toEqual({
    primaryLinkUrl: "https://acme.com",
  });
});

test("create opportunity: amount in micros, currency, default stage NEW", async () => {
  const { deps, execs } = fakeTwenty({
    create_one_opportunity: { id: UUID(7) },
  });

  noSchemaError(
    await doTwentyWrite(
      {
        op: "create",
        type: "opportunity",
        name: "Big deal",
        amount: 1234.5,
        currency: "eur",
      },
      ctx(),
      deps
    )
  );
  expect(execs[0]?.args).toMatchObject({
    stage: "NEW",
    amount: { amountMicros: 1_234_500_000, currencyCode: "EUR" },
  });
});

test("bad stage / amount are refused before calling Twenty", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyWrite(
      { op: "create", type: "opportunity", name: "x", stage: "lost" },
      ctx(),
      deps
    )
  ).toContain("stage must be one of");
  expect(
    await doTwentyWrite(
      { op: "create", type: "opportunity", name: "x", amount: "5k" },
      ctx(),
      deps
    )
  ).toContain("amount must be a number");
  expect(execs).toHaveLength(0);
});

test("create without a name is refused", async () => {
  const { deps } = fakeTwenty({});

  expect(
    await doTwentyWrite(
      { op: "create", type: "person", email: "a@b.test" },
      ctx(),
      deps
    )
  ).toContain("`firstName` and/or `lastName`");
  expect(
    await doTwentyWrite({ op: "create", type: "company" }, ctx(), deps)
  ).toContain("needs a `name`");
});

for (const type of ["person", "company", "opportunity"] as const) {
  test(`update ${type}: id + only the changed fields, schema-valid`, async () => {
    const { deps, execs } = fakeTwenty({
      [`update_one_${type}`]: { id: UUID(1) },
    });

    const out = await doTwentyWrite(
      {
        op: "update",
        type,
        id: UUID(1),
        jobTitle: "VP",
        name: "New name",
        stage: "WON",
      },
      ctx(),
      deps
    );

    noSchemaError(out);
    expect(out).toContain(`updated ${type} ${UUID(1)}`);
    expect(execs[0]?.args.id).toBe(UUID(1));
    expect(execs[0]?.args).not.toHaveProperty("position");
  });
}

test("update with nothing to change never calls Twenty", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyWrite(
      { op: "update", type: "person", id: UUID(1) },
      ctx(),
      deps
    )
  ).toContain("nothing to change");
  expect(execs).toHaveLength(0);
});

test("note attached to a person: create_one_note then a target with the new id", async () => {
  const { deps, execs } = fakeTwenty({
    create_one_note: { id: UUID(3) },
    create_one_note_target: { id: UUID(9) },
  });

  const out = await doTwentyWrite(
    {
      op: "note",
      type: "person",
      id: UUID(1),
      title: "Call recap",
      body: "Wants a **quote**",
    },
    ctx(),
    deps
  );

  expect(out).toBe(`created note ${UUID(3)} on person ${UUID(1)}`);
  expect(execs[0]?.args).toEqual({
    title: "Call recap",
    position: "first",
    bodyV2: { markdown: "Wants a **quote**" },
  });
  expect(execs[1]?.args).toEqual({
    noteId: UUID(3),
    targetPersonId: UUID(1),
    position: "first",
  });
});

test("task on an opportunity with due date and status", async () => {
  const { deps, execs } = fakeTwenty({
    create_one_task: { id: UUID(4) },
    create_one_task_target: { id: UUID(8) },
  });

  const out = await doTwentyWrite(
    {
      op: "task",
      type: "opportunity",
      id: UUID(7),
      title: "Send quote",
      dueAt: "2026-10-01T09:00:00Z",
      status: "in_progress",
    },
    ctx(),
    deps
  );

  expect(out).toBe(`created task ${UUID(4)} on opportunity ${UUID(7)}`);
  expect(execs[0]?.args).toMatchObject({
    status: "IN_PROGRESS",
    dueAt: "2026-10-01T09:00:00Z",
  });
  expect(execs[1]?.args).toEqual({
    taskId: UUID(4),
    targetOpportunityId: UUID(7),
    position: "first",
  });
});

test("a standalone note (no target) makes one call", async () => {
  const { deps, execs } = fakeTwenty({ create_one_note: { id: UUID(3) } });

  expect(await doTwentyWrite({ op: "note", title: "Idea" }, ctx(), deps)).toBe(
    `created note ${UUID(3)}`
  );
  expect(execs).toHaveLength(1);
});

test("a note whose link fails still reports the note it made", async () => {
  const { deps } = fakeTwenty({ create_one_note: { id: UUID(3) } });
  const failing: ITwentyDeps = {
    registry: {
      has: (n) => deps.registry?.has(n) ?? false,
      callTool: async (n, a) =>
        isRecord(a) && a.toolName === "create_one_note_target"
          ? `MCP tool '${n}' failed: ${JSON.stringify({ success: false, error: "Invalid UUID value" })}`
          : (deps.registry?.callTool(n, a) ?? ""),
    },
  };

  const out = await doTwentyWrite(
    { op: "note", type: "company", id: UUID(2), title: "x" },
    ctx(),
    failing
  );

  expect(out).toContain(
    `created note ${UUID(3)} but linking it to company ${UUID(2)} failed — twenty: Invalid UUID value`
  );
});

test("a note with an id but no type asks for the type", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyWrite({ op: "note", id: UUID(1), title: "x" }, ctx(), deps)
  ).toContain("pass `type`");
  expect(execs).toHaveLength(0);
});

test("writes fail closed with the capability off", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyWrite({ op: "note", title: "x" }, ctx(false), deps)
  ).toContain("capability is off");
  expect(execs).toHaveLength(0);
});

test("there is no delete op", async () => {
  const { deps, execs } = fakeTwenty({});

  expect(
    await doTwentyWrite(
      { op: "delete", type: "person", id: UUID(1) },
      ctx(),
      deps
    )
  ).toContain("unknown op");
  expect(execs).toHaveLength(0);
});

// ── units ───────────────────────────────────────────────────────────────────

test("twentyError pulls Twenty's reason out of the registry sentinel", () => {
  expect(
    twentyError(
      `MCP tool 'mcp__twenty__execute_tool' failed: {"success":false,"message":"Failed","error":"Object person doesn't have any \\"x\\" field."}`
    )
  ).toBe('twenty: Object person doesn\'t have any "x" field.');
  expect(twentyError("MCP tool 'x' failed: boom")).toBe("twenty: boom");
  // the live server's real message when a soft-deleted twin holds the domain
  expect(
    twentyError(
      `MCP tool 'x' failed: {"success":false,"error":"A duplicate entry was detected: unique constraint company.IDX_UNIQUE_2a32 was violated"}`
    )
  ).toContain("already exists");
});

test("recordLine renders opportunity money and dates", () => {
  expect(
    recordLine("opportunity", {
      id: UUID(7),
      name: "Deal",
      stage: "PROPOSAL",
      amount: { amountMicros: 1_234_000_000, currencyCode: "EUR" },
      closeDate: "2026-12-31T00:00:00.000Z",
      company: { id: UUID(2), name: "Example Co" },
    })
  ).toBe(
    `Deal · [PROPOSAL] · 1,234 EUR · closes 2026-12-31 · Example Co  (${UUID(7)})`
  );
});

test("capability: on iff a `twenty` server is connected and not killed", () => {
  expect(resolveTwentyCapability({ serverNames: () => ["twenty"] })).toBe(true);
  expect(resolveTwentyCapability({ serverNames: () => ["linear"] })).toBe(
    false
  );
  process.env.TSFORGE_NO_TWENTY = "1";
  expect(resolveTwentyCapability({ serverNames: () => ["twenty"] })).toBe(
    false
  );
  delete process.env.TSFORGE_NO_TWENTY;
});
