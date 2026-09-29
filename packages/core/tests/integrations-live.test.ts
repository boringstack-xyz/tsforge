/**
 * Live contract tests for the Twenty and Chatwoot integrations — the real verbs
 * against YOUR real servers, read from ~/.tsforge (models.json `mcpServers.twenty`,
 * config.json chatwoot* settings). Skipped unless asked for:
 *
 *   TSFORGE_LIVE=1 bun test tests/integrations-live.test.ts
 *
 * Reads only by default. Writes are opt-in and clean up after themselves:
 *   TSFORGE_LIVE_WRITES=1               Twenty: create a tsforge-test company,
 *                                       person, deal, note and task, then delete
 *   TSFORGE_LIVE_CHATWOOT_CONVERSATION=N Chatwoot: private note, add a label,
 *                                       toggle status and restore, on #N
 *
 * The assertions check shape, never values, so no CRM data is printed.
 */
import { test, expect, afterAll } from "bun:test";
import { homedir } from "node:os";
import { applySettings } from "../src/config/user-settings";
import { loadGlobalMcpServers } from "../src/models-config";
import {
  connectMcpServers,
  type IMcpServerConfig,
  type McpRegistry,
} from "../src/mcp";
import {
  doTwentyRead,
  doTwentyWrite,
  execTwenty,
} from "../src/loop/tools/twenty-ops";
import {
  chatwootApi,
  chatwootConfig,
  doChatwootRead,
  doChatwootWrite,
  type IChatwootDeps,
} from "../src/loop/tools/chatwoot-ops";
import type { IToolContext } from "../src/loop/tools";

const LIVE = process.env.TSFORGE_LIVE === "1";
const WRITES = process.env.TSFORGE_LIVE_WRITES === "1";
const CONVERSATION = Number(
  process.env.TSFORGE_LIVE_CHATWOOT_CONVERSATION ?? ""
);

/** Read the REAL ~/.tsforge once (the test preload points TSFORGE_HOME at an
 *  empty temp dir so ordinary runs never touch it), then restore isolation. */
async function loadLiveConfig(): Promise<Record<string, IMcpServerConfig>> {
  const isolated = process.env.TSFORGE_HOME;

  process.env.TSFORGE_HOME = homedir();

  try {
    applySettings(process.env, null);
    const all = await loadGlobalMcpServers();

    return all.twenty === undefined ? {} : { twenty: all.twenty };
  } finally {
    process.env.TSFORGE_HOME = isolated;
  }
}

const twentyServers = LIVE ? await loadLiveConfig() : {};
const HAS_TWENTY = LIVE && twentyServers.twenty !== undefined;
const HAS_CHATWOOT = LIVE && chatwootConfig() !== null;

let registry: McpRegistry | null = null;

async function twentyCtx(): Promise<IToolContext> {
  registry ??= await connectMcpServers(twentyServers, () => {});

  if (registry === null) {
    throw new Error("could not connect to the twenty MCP server");
  }

  return {
    cwd: ".",
    files: [],
    report: () => {},
    task: "live",
    twenty: true,
    mcpRegistry: registry,
  };
}

const chatwootCtx: IToolContext = {
  cwd: ".",
  files: [],
  report: () => {},
  task: "live",
  chatwoot: true,
};

afterAll(async () => {
  await registry?.closeAll();
});

/** A verb's output that came back as an error rather than data. */
function looksBroken(out: string): boolean {
  return /^twenty:|HTTP \d{3}|failed|capability is off|undefined|NaN|\[object /u.test(
    out
  );
}

const UUID_IN = /\(([0-9a-f-]{36})\)/u;

const GQL_TYPE: Record<string, string> = {
  company: "Company",
  person: "Person",
  opportunity: "Opportunity",
  note: "Note",
  task: "Task",
};

/** Remove a test record for good. The MCP delete is a soft delete, and a
 *  trashed record still holds its unique fields (a company domain), so the
 *  live run finishes with GraphQL's destroy — same key, same instance. */
async function destroyTwenty(type: string, id: string): Promise<void> {
  const cfg = twentyServers.twenty;
  const url = cfg?.url?.replace(/\/mcp\/?$/u, "/graphql");

  if (url === undefined) {
    return;
  }

  await fetch(url, {
    method: "POST",
    headers: { ...(cfg?.headers ?? {}), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `mutation { destroy${GQL_TYPE[type] ?? ""}(id: "${id}") { id } }`,
    }),
  });
}

// ── Twenty ──────────────────────────────────────────────────────────────────

for (const type of ["person", "company", "opportunity", "task", "note"]) {
  test.skipIf(!HAS_TWENTY)(`twenty live: list + search ${type}`, async () => {
    const ctx = await twentyCtx();
    const list = await doTwentyRead({ op: "list", type, limit: 3 }, ctx);
    const search = await doTwentyRead(
      { op: "search", type, query: "e", limit: 3 },
      ctx
    );

    expect(looksBroken(list)).toBe(false);
    expect(looksBroken(search)).toBe(false);

    const id = UUID_IN.exec(list)?.[1];

    if (id !== undefined) {
      expect(
        looksBroken(await doTwentyRead({ op: "record", type, id }, ctx))
      ).toBe(false);
    }
  });
}

test.skipIf(!HAS_TWENTY)("twenty live: pipeline", async () => {
  expect(
    looksBroken(await doTwentyRead({ op: "pipeline" }, await twentyCtx()))
  ).toBe(false);
});

test.skipIf(!HAS_TWENTY || !WRITES)(
  "twenty live: create → update → note + task → read back → delete",
  async () => {
    const ctx = await twentyCtx();
    const reg = ctx.mcpRegistry;
    const made: [string, string][] = [];
    const run = `tsforge-test-${String(Date.now())}`;

    const id = (out: string): string => {
      const m = /([0-9a-f]{8}-[0-9a-f-]{27})/u.exec(out)?.[1];

      expect(m).toBeDefined();

      return m ?? "";
    };

    try {
      const co = await doTwentyWrite(
        {
          op: "create",
          type: "company",
          name: `${run} company`,
          domain: `${run}.example`,
        },
        ctx
      );

      expect(co).toStartWith("created company ");
      made.push(["company", id(co)]);

      const p = await doTwentyWrite(
        {
          op: "create",
          type: "person",
          firstName: "Tsforge",
          lastName: "Test",
          email: `${run}@example.com`,
          companyId: id(co),
        },
        ctx
      );

      expect(p).toStartWith("created person ");
      made.push(["person", id(p)]);

      const deal = await doTwentyWrite(
        {
          op: "create",
          type: "opportunity",
          name: "tsforge-test deal",
          stage: "PROPOSAL",
          amount: 1234,
          currency: "EUR",
          companyId: id(co),
          pointOfContactId: id(p),
        },
        ctx
      );

      expect(deal).toStartWith("created opportunity ");
      made.push(["opportunity", id(deal)]);

      expect(
        await doTwentyWrite(
          { op: "update", type: "person", id: id(p), jobTitle: "Tester" },
          ctx
        )
      ).toContain("updated person");

      const note = await doTwentyWrite(
        {
          op: "note",
          type: "person",
          id: id(p),
          title: "tsforge-test note",
          body: "live **test**",
        },
        ctx
      );

      expect(note).toContain(`on person ${id(p)}`);
      made.push(["note", id(note)]);

      const task = await doTwentyWrite(
        {
          op: "task",
          type: "opportunity",
          id: id(deal),
          title: "tsforge-test task",
          dueAt: "2026-10-01T09:00:00.000Z",
        },
        ctx
      );

      expect(task).toContain(`on opportunity ${id(deal)}`);
      made.push(["task", id(task)]);

      const person = await doTwentyRead(
        { op: "record", type: "person", id: id(p) },
        ctx
      );

      expect(person).toContain("Tsforge Test");
      expect(person).toContain("Tester");
      expect(person).toContain("tsforge-test note");

      const dealView = await doTwentyRead(
        { op: "record", type: "opportunity", id: id(deal) },
        ctx
      );

      expect(dealView).toContain("[PROPOSAL]");
      expect(dealView).toContain("1,234 EUR");
      expect(dealView).toContain("tsforge-test task");
      expect(await doTwentyRead({ op: "pipeline" }, ctx)).toContain(
        "PROPOSAL:"
      );
    } finally {
      // no delete verb by design; soft-delete through the raw tool, then destroy
      for (const [type, rid] of made.reverse()) {
        if (reg !== undefined) {
          await execTwenty(reg, `delete_one_${type}`, { id: rid });
        }

        await destroyTwenty(type, rid);
      }
    }
  },
  60_000
);

// ── Chatwoot ────────────────────────────────────────────────────────────────

for (const args of [
  { op: "conversations", status: "all" },
  { op: "conversations", assignee: "me" },
  { op: "inboxes" },
  { op: "agents" },
  { op: "labels" },
  { op: "contacts", query: "e" },
]) {
  test.skipIf(!HAS_CHATWOOT)(
    `chatwoot live: ${JSON.stringify(args)}`,
    async () => {
      expect(looksBroken(await doChatwootRead(args, chatwootCtx))).toBe(false);
    }
  );
}

test.skipIf(!HAS_CHATWOOT)(
  "chatwoot live: one conversation + one contact",
  async () => {
    const list = await doChatwootRead(
      { op: "conversations", status: "all" },
      chatwootCtx
    );
    const conv = /#(\d+) \[/u.exec(list)?.[1];

    if (conv !== undefined) {
      const out = await doChatwootRead(
        { op: "conversation", id: Number(conv) },
        chatwootCtx
      );

      expect(looksBroken(out)).toBe(false);
      expect(out).toMatch(/\/app\/accounts\/\d+\/conversations\/\d+/u);
    }

    const contacts = await doChatwootRead(
      { op: "contacts", query: "e" },
      chatwootCtx
    );
    const contact = /contact (\d+):/u.exec(contacts)?.[1];

    if (contact !== undefined) {
      expect(
        looksBroken(
          await doChatwootRead(
            { op: "contact", id: Number(contact) },
            chatwootCtx
          )
        )
      ).toBe(false);
    }
  }
);

test.skipIf(
  !HAS_CHATWOOT || !Number.isInteger(CONVERSATION) || CONVERSATION <= 0
)(
  "chatwoot live: private note, add label, toggle status and restore",
  async () => {
    const deps: IChatwootDeps = {
      config: chatwootConfig(),
      fetch: (u, i) => fetch(u, i),
    };
    const before = await chatwootApi(
      deps,
      "GET",
      `/conversations/${String(CONVERSATION)}`
    );

    expect(before.ok).toBe(true);

    const rec =
      before.ok && typeof before.data === "object" && before.data !== null
        ? Object.fromEntries(Object.entries(before.data))
        : {};
    const status = typeof rec.status === "string" ? rec.status : "open";
    const labels = Array.isArray(rec.labels)
      ? rec.labels.filter((l): l is string => typeof l === "string")
      : [];

    try {
      expect(
        await doChatwootWrite(
          {
            op: "note",
            id: CONVERSATION,
            body: "tsforge live test (private note, safe to delete)",
          },
          chatwootCtx,
          deps
        )
      ).toContain("private note");
      expect(
        await doChatwootWrite(
          { op: "label", id: CONVERSATION, labels: ["tsforge-test"] },
          chatwootCtx,
          deps
        )
      ).toContain("tsforge-test");

      const flip = status === "resolved" ? "open" : "resolved";

      expect(
        await doChatwootWrite(
          { op: "status", id: CONVERSATION, status: flip },
          chatwootCtx,
          deps
        )
      ).toBe(`#${String(CONVERSATION)} is now ${flip}`);
    } finally {
      await chatwootApi(
        deps,
        "POST",
        `/conversations/${String(CONVERSATION)}/toggle_status`,
        { status }
      );
      await chatwootApi(
        deps,
        "POST",
        `/conversations/${String(CONVERSATION)}/labels`,
        { labels }
      );
    }
  },
  30_000
);
