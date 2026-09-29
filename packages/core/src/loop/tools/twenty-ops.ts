import { flags } from "../../config";
import { str, reject, type IToolContext } from "./tool-context";
import { intArg, capHead } from "./vcs-common";
import {
  callFirst,
  field,
  isRecord,
  jsonParseSafe,
  resolveMcpCapability,
  type IIntegrationRegistry,
} from "./integration-common";
import { LOOP_LIMITS } from "../loop.constants";

/**
 * Twenty CRM as curated verbs over its MCP server. Twenty's MCP is a meta-tool
 * surface (get_tool_catalog → learn_tools → execute_tool over ~300 generated
 * tools); these verbs call `execute_tool` with the exact inner tool names and
 * argument shapes Twenty validates (it rejects unknown fields, requires `select`
 * on reads and `position` on creates), so the model never has to learn them.
 */

/** The required config key for the Twenty MCP server. */
export const TWENTY_SERVER = "twenty";

const CAPABILITY_OFF =
  "the Twenty capability is off — add a `twenty` MCP server (type http, url " +
  "https://<your-twenty>/mcp, Authorization: Bearer <API key>) to `mcpServers` " +
  "in ~/.tsforge/models.json (and ensure TSFORGE_NO_TWENTY is unset).";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface ITwentyDeps {
  registry: IIntegrationRegistry | undefined;
}

export function resolveTwentyCapability(
  registry: { serverNames(): string[] } | null | undefined
): boolean {
  return resolveMcpCapability(registry, TWENTY_SERVER, flags.noTwenty());
}

// ── object model ─────────────────────────────────────────────────────────────

export type TwentyType = "person" | "company" | "opportunity" | "task" | "note";

interface ITypeDef {
  /** Tool-name forms: find_many_<plural>, find_one_<singular>. */
  plural: string;
  singular: string;
  /** Fields for list rows and for the single-record view. */
  listSelect: readonly string[];
  recordSelect: readonly string[];
  /** Text-search filter for `query` (a top-level `or`). */
  search: (like: string) => Record<string, unknown>[];
  /** The `target<X>Id` key on note/task targets, when notes/tasks can attach. */
  targetKey?: string;
}

const TYPES: Record<TwentyType, ITypeDef> = {
  person: {
    plural: "people",
    singular: "person",
    listSelect: ["id", "name", "emails", "jobTitle", "company"],
    recordSelect: [
      "id",
      "name",
      "emails",
      "phones",
      "jobTitle",
      "company",
      "linkedinLink",
      "createdAt",
    ],
    search: (like) => [
      { name: { firstName: { ilike: like } } },
      { name: { lastName: { ilike: like } } },
      { emails: { primaryEmail: { ilike: like } } },
    ],
    targetKey: "targetPersonId",
  },
  company: {
    plural: "companies",
    singular: "company",
    listSelect: ["id", "name", "domainName", "accountOwner"],
    recordSelect: [
      "id",
      "name",
      "domainName",
      "accountOwner",
      "address",
      "people",
      "createdAt",
    ],
    search: (like) => [
      { name: { ilike: like } },
      { domainName: { primaryLinkUrl: { ilike: like } } },
    ],
    targetKey: "targetCompanyId",
  },
  opportunity: {
    plural: "opportunities",
    singular: "opportunity",
    listSelect: ["id", "name", "stage", "amount", "closeDate", "company"],
    recordSelect: [
      "id",
      "name",
      "stage",
      "amount",
      "closeDate",
      "company",
      "pointOfContact",
      "owner",
      "createdAt",
    ],
    search: (like) => [{ name: { ilike: like } }],
    targetKey: "targetOpportunityId",
  },
  task: {
    plural: "tasks",
    singular: "task",
    listSelect: ["id", "title", "status", "dueAt", "assignee"],
    recordSelect: [
      "id",
      "title",
      "status",
      "dueAt",
      "assignee",
      "bodyV2",
      "createdAt",
    ],
    search: (like) => [{ title: { ilike: like } }],
  },
  note: {
    plural: "notes",
    singular: "note",
    listSelect: ["id", "title", "createdAt"],
    recordSelect: ["id", "title", "bodyV2", "createdAt"],
    search: (like) => [{ title: { ilike: like } }],
  },
};

const TYPE_NAMES = Object.keys(TYPES).join("|");
const STAGES = [
  "NEW",
  "CONTACTED",
  "IN_DISCUSSION",
  "PROPOSAL",
  "WON",
  "NOT_PROCEEDING",
] as const;
const TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE"] as const;
/** Widened once so `.includes(someString)` type-checks without a cast. */
const STAGE_NAMES: readonly string[] = STAGES;
const TASK_STATUS_NAMES: readonly string[] = TASK_STATUSES;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isType(t: string): t is TwentyType {
  return Object.hasOwn(TYPES, t);
}

function typeArg(args: Record<string, unknown>): TwentyType | undefined {
  const t = str(args, "type").trim().toLowerCase();
  const alias: Record<string, TwentyType> = {
    people: "person",
    contact: "person",
    companies: "company",
    opportunities: "opportunity",
    deal: "opportunity",
    tasks: "task",
    notes: "note",
  };

  return isType(t) ? t : alias[t];
}

// ── execute_tool ─────────────────────────────────────────────────────────────

type ExecResult =
  | { ok: true; result: Record<string, unknown>; refs: Map<string, string> }
  | { ok: false; error: string };

/** Twenty's failure JSON (`{success:false,error,message}`) out of the registry's
 *  "MCP tool '…' failed: <text>" sentinel, as one plain line. */
export function twentyError(raw: string): string {
  const at = raw.indexOf("failed: ");
  const text = at === -1 ? raw : raw.slice(at + 8);
  const parsed = jsonParseSafe(text);

  if (isRecord(parsed)) {
    const err = field(parsed, "error", "message");

    if (/duplicate entry|unique constraint/iu.test(err)) {
      return "twenty: that record already exists — a unique field (a company domain, a person's email) is taken. Search for it, and note that deleted records in Twenty's trash still count until the trash is emptied.";
    }

    if (err.length > 0) {
      return `twenty: ${err}`;
    }
  }

  return `twenty: ${text.slice(0, 400)}`;
}

/** Call one inner Twenty tool through `execute_tool`. Never throws. */
export async function execTwenty(
  reg: IIntegrationRegistry,
  toolName: string,
  args: Record<string, unknown>
): Promise<ExecResult> {
  const res = await callFirst(reg, TWENTY_SERVER, ["execute_tool"], {
    toolName,
    arguments: args,
  });

  if ("error" in res) {
    return { ok: false, error: twentyError(res.error) };
  }

  const parsed = jsonParseSafe(res.text);

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: `twenty: unexpected reply from ${toolName}: ${res.text.slice(0, 200)}`,
    };
  }

  if (parsed.success === false) {
    return { ok: false, error: twentyError(JSON.stringify(parsed)) };
  }

  const refs = new Map<string, string>();

  if (Array.isArray(parsed.recordReferences)) {
    for (const r of parsed.recordReferences.filter(isRecord)) {
      refs.set(field(r, "recordId"), field(r, "displayName"));
    }
  }

  return {
    ok: true,
    result: isRecord(parsed.result) ? parsed.result : {},
    refs,
  };
}

function records(result: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(result.records) ? result.records.filter(isRecord) : [];
}

// ── rendering ────────────────────────────────────────────────────────────────

function sub(
  rec: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const v = rec[key];

  return isRecord(v) ? v : {};
}

/** A relation summary ({id, label|name}) or a composite name as text. */
function label(v: unknown): string {
  if (!isRecord(v)) {
    return "";
  }

  const full = `${field(v, "firstName")} ${field(v, "lastName")}`.trim();

  if (full.length > 0) {
    return full;
  }

  const name = v.name;

  return isRecord(name) ? label(name) : field(v, "label", "name", "title");
}

function money(v: unknown): string {
  if (!isRecord(v) || typeof v.amountMicros !== "number") {
    return "";
  }

  const amount = v.amountMicros / 1_000_000;

  return `${amount.toLocaleString("en-US")} ${field(v, "currencyCode")}`.trim();
}

function day(v: unknown): string {
  return typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : "";
}

/** One record as a compact line, per type. */
export function recordLine(
  type: TwentyType,
  r: Record<string, unknown>
): string {
  const id = field(r, "id");
  let parts: string[];

  switch (type) {
    case "person":
      parts = [
        label(r.name),
        field(sub(r, "emails"), "primaryEmail"),
        field(r, "jobTitle"),
        label(r.company),
      ];
      break;
    case "company":
      parts = [
        field(r, "name"),
        field(sub(r, "domainName"), "primaryLinkUrl"),
        label(r.accountOwner).length > 0
          ? `owner ${label(r.accountOwner)}`
          : "",
      ];
      break;
    case "opportunity":
      parts = [
        field(r, "name"),
        `[${field(r, "stage")}]`,
        money(r.amount),
        day(r.closeDate).length > 0 ? `closes ${day(r.closeDate)}` : "",
        label(r.company),
      ];
      break;
    case "task":
      parts = [
        field(r, "title"),
        `[${field(r, "status")}]`,
        day(r.dueAt).length > 0 ? `due ${day(r.dueAt)}` : "",
        label(r.assignee).length > 0 ? `→ ${label(r.assignee)}` : "",
      ];
      break;
    case "note":
      parts = [field(r, "title"), day(r.createdAt)];
      break;
  }

  const text = parts.filter((p) => p.length > 0 && p !== "[]").join(" · ");

  return `${text.length > 0 ? text : "(untitled)"}  (${id})`;
}

/** The full view of one record: its line, then detail fields. */
function recordDetail(type: TwentyType, r: Record<string, unknown>): string[] {
  const lines = [recordLine(type, r)];
  const phone = field(sub(r, "phones"), "primaryPhoneNumber");
  const linkedin = field(sub(r, "linkedinLink"), "primaryLinkUrl");
  const body = field(sub(r, "bodyV2"), "markdown");
  const people = Array.isArray(r.people)
    ? r.people.map(label).filter((p) => p.length > 0)
    : [];
  const address = sub(r, "address");
  const city = [field(address, "addressCity"), field(address, "addressCountry")]
    .filter((s) => s.length > 0)
    .join(", ");

  if (phone.length > 0) {
    lines.push(
      `phone: ${field(sub(r, "phones"), "primaryPhoneCallingCode")}${phone}`
    );
  }

  if (linkedin.length > 0) {
    lines.push(`linkedin: ${linkedin}`);
  }

  if (city.length > 0) {
    lines.push(`address: ${city}`);
  }

  if (label(r.pointOfContact).length > 0) {
    lines.push(`point of contact: ${label(r.pointOfContact)}`);
  }

  if (label(r.owner).length > 0) {
    lines.push(`owner: ${label(r.owner)}`);
  }

  if (people.length > 0) {
    lines.push(`people: ${people.join(", ")}`);
  }

  if (body.length > 0) {
    lines.push("", body);
  }

  return lines;
}

// ── reads ────────────────────────────────────────────────────────────────────

function limitArg(args: Record<string, unknown>): number {
  return Math.min(intArg(args, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT);
}

async function findMany(
  reg: IIntegrationRegistry,
  type: TwentyType,
  args: Record<string, unknown>,
  max: number
): Promise<string> {
  const def = TYPES[type];
  const query = str(args, "query").trim();
  const payload: Record<string, unknown> = {
    select: [...def.listSelect],
    limit: limitArg(args),
    orderBy: [{ updatedAt: "DescNullsLast" }],
  };

  if (query.length > 0) {
    payload.or = def.search(`%${query}%`);
  }

  const res = await execTwenty(reg, `find_many_${def.plural}`, payload);

  if (!res.ok) {
    return res.error;
  }

  const rows = records(res.result).map((r) => recordLine(type, r));
  const total = field(res.result, "count");

  if (rows.length === 0) {
    return query.length > 0
      ? `no ${def.plural} matching "${query}"`
      : `no ${def.plural}`;
  }

  const more =
    res.result.hasNextPage === true
      ? ` — more exist (${total} total); refine the query or raise limit`
      : "";

  return capHead(
    [`${def.plural} (${String(rows.length)}${more})`, ...rows].join("\n"),
    max
  );
}

/** Titles of the notes and tasks attached to a person/company/opportunity. */
async function attached(
  reg: IIntegrationRegistry,
  targetKey: string,
  id: string
): Promise<string[]> {
  const filter = { [targetKey]: { eq: id } };
  const [notes, tasks] = await Promise.all([
    execTwenty(reg, "find_many_note_targets", {
      select: ["note"],
      limit: 20,
      ...filter,
    }),
    execTwenty(reg, "find_many_task_targets", {
      select: ["task"],
      limit: 20,
      ...filter,
    }),
  ]);
  const lines: string[] = [];

  const list = (res: ExecResult, key: string, heading: string): void => {
    if (!res.ok) {
      lines.push(`${heading}: ${res.error}`);

      return;
    }

    const items = records(res.result)
      .map((t) => sub(t, key))
      .map((n) => {
        const title = label(n);

        return `- ${title.length > 0 ? title : "(untitled)"}  (${field(n, "id")})`;
      });

    if (items.length > 0) {
      lines.push(`${heading}:`, ...items);
    }
  };

  list(notes, "note", "notes");
  list(tasks, "task", "tasks");

  return lines;
}

async function findOne(
  reg: IIntegrationRegistry,
  type: TwentyType,
  id: string,
  max: number
): Promise<string> {
  const def = TYPES[type];
  const res = await execTwenty(reg, `find_one_${def.singular}`, {
    id,
    select: [...def.recordSelect],
  });

  if (!res.ok) {
    return res.error;
  }

  const rec = records(res.result)[0];

  if (rec === undefined) {
    return `no ${def.singular} with id ${id}`;
  }

  const extra =
    def.targetKey === undefined ? [] : await attached(reg, def.targetKey, id);

  return capHead(
    [
      ...recordDetail(type, rec),
      ...(extra.length > 0 ? ["", ...extra] : []),
    ].join("\n"),
    max
  );
}

async function pipeline(
  reg: IIntegrationRegistry,
  max: number
): Promise<string> {
  const [count, sum] = await Promise.all([
    execTwenty(reg, "group_by_opportunities", { groupBy: [{ stage: true }] }),
    execTwenty(reg, "group_by_opportunities", {
      groupBy: [{ stage: true }],
      aggregateOperation: "SUM",
      aggregateFieldName: "amount.amountMicros",
    }),
  ]);

  if (!count.ok) {
    return count.error;
  }

  const groups = (res: ExecResult): Map<string, number> => {
    const out = new Map<string, number>();

    if (!res.ok || !Array.isArray(res.result.groups)) {
      return out;
    }

    // Twenty v2.41: {groups:[{dimensions:["PROPOSAL"], value:"3"}]} — the value
    // is a string, the dimension null for records with no stage.
    for (const g of res.result.groups.filter(isRecord)) {
      const dims = Array.isArray(g.dimensions) ? g.dimensions : [];
      const stage = typeof dims[0] === "string" ? dims[0] : "(none)";
      const value = Number(g.value);

      out.set(stage, Number.isFinite(value) ? value : 0);
    }

    return out;
  };

  const counts = groups(count);
  const sums = groups(sum);

  if (counts.size === 0) {
    return "no opportunities yet";
  }

  const known: string[] = STAGES.filter((s) => counts.has(s));
  const rows = known
    .concat([...counts.keys()].filter((k) => !known.includes(k)))
    .map((s) => {
      const micros = sums.get(s) ?? 0;

      return `${s}: ${String(counts.get(s) ?? 0)}${micros > 0 ? ` · ${(micros / 1_000_000).toLocaleString("en-US")}` : ""}`;
    });

  return capHead(
    ["opportunities by stage (count · total amount):", ...rows].join("\n"),
    max
  );
}

// ── writes ───────────────────────────────────────────────────────────────────

type Mapped =
  { ok: true; fields: Record<string, unknown> } | { ok: false; error: string };

function has(args: Record<string, unknown>, key: string): boolean {
  return str(args, key).trim().length > 0;
}

function setIf(out: Record<string, unknown>, key: string, value: string): void {
  if (value.trim().length > 0) {
    out[key] = value.trim();
  }
}

function personFields(args: Record<string, unknown>): Mapped {
  const out: Record<string, unknown> = {};

  if (has(args, "firstName") || has(args, "lastName")) {
    const name: Record<string, string> = {};

    setIf(name, "firstName", str(args, "firstName"));
    setIf(name, "lastName", str(args, "lastName"));
    out.name = name;
  }

  if (has(args, "email")) {
    out.emails = { primaryEmail: str(args, "email").trim() };
  }

  if (has(args, "phone")) {
    out.phones = { primaryPhoneNumber: str(args, "phone").trim() };
  }

  setIf(out, "jobTitle", str(args, "jobTitle"));
  setIf(out, "companyId", str(args, "companyId"));

  return { ok: true, fields: out };
}

function companyFields(args: Record<string, unknown>): Mapped {
  const out: Record<string, unknown> = {};
  const domain = str(args, "domain").trim();

  setIf(out, "name", str(args, "name"));

  if (domain.length > 0) {
    out.domainName = {
      primaryLinkUrl: /^https?:\/\//u.test(domain)
        ? domain
        : `https://${domain}`,
    };
  }

  return { ok: true, fields: out };
}

function opportunityFields(args: Record<string, unknown>): Mapped {
  const out: Record<string, unknown> = {};
  const stage = str(args, "stage").trim().toUpperCase();
  const amount = args.amount;

  setIf(out, "name", str(args, "name"));

  if (stage.length > 0) {
    if (!STAGE_NAMES.includes(stage)) {
      return { ok: false, error: `stage must be one of ${STAGES.join("|")}` };
    }

    out.stage = stage;
  }

  if (amount !== undefined) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return {
        ok: false,
        error: "amount must be a number in whole currency units (e.g. 5000)",
      };
    }

    const currency = str(args, "currency").trim().toUpperCase();

    out.amount = {
      amountMicros: Math.round(amount * 1_000_000),
      currencyCode: currency.length > 0 ? currency : "USD",
    };
  }

  setIf(out, "closeDate", str(args, "closeDate"));
  setIf(out, "companyId", str(args, "companyId"));
  setIf(out, "pointOfContactId", str(args, "pointOfContactId"));

  return { ok: true, fields: out };
}

function mapFields(type: TwentyType, args: Record<string, unknown>): Mapped {
  switch (type) {
    case "person":
      return personFields(args);
    case "company":
      return companyFields(args);
    case "opportunity":
      return opportunityFields(args);
    default:
      return {
        ok: false,
        error: `use op 'note' or 'task' to create a ${type}`,
      };
  }
}

function createdId(res: ExecResult): string {
  if (!res.ok) {
    return "";
  }

  const rec = records(res.result)[0] ?? res.result;

  return field(rec, "id");
}

async function createRecord(
  reg: IIntegrationRegistry,
  type: TwentyType,
  args: Record<string, unknown>
): Promise<string> {
  const mapped = mapFields(type, args);

  if (!mapped.ok) {
    return `twenty_write create: ${mapped.error}`;
  }

  const f = mapped.fields;
  const missing =
    (type === "person" && f.name === undefined) ||
    ((type === "company" || type === "opportunity") && f.name === undefined);

  if (missing) {
    return `twenty_write create: a ${type} needs ${type === "person" ? "`firstName` and/or `lastName`" : "a `name`"}`;
  }

  if (type === "opportunity" && f.stage === undefined) {
    f.stage = "NEW";
  }

  const res = await execTwenty(reg, `create_one_${TYPES[type].singular}`, {
    ...f,
    position: "first",
  });

  if (!res.ok) {
    return res.error;
  }

  return `created ${type} ${createdId(res)}`;
}

async function updateRecord(
  reg: IIntegrationRegistry,
  type: TwentyType,
  id: string,
  args: Record<string, unknown>
): Promise<string> {
  const mapped = mapFields(type, args);

  if (!mapped.ok) {
    return `twenty_write update: ${mapped.error}`;
  }

  if (Object.keys(mapped.fields).length === 0) {
    return "twenty_write update: nothing to change — pass the fields to set";
  }

  const res = await execTwenty(reg, `update_one_${TYPES[type].singular}`, {
    id,
    ...mapped.fields,
  });

  return res.ok
    ? `updated ${type} ${id} (${Object.keys(mapped.fields).join(", ")})`
    : res.error;
}

/** Link a new note/task to the record it is about. */
async function linkTarget(
  reg: IIntegrationRegistry,
  kind: "note" | "task",
  childId: string,
  target: { type: TwentyType; id: string } | undefined
): Promise<string> {
  if (target === undefined) {
    return "";
  }

  const key = TYPES[target.type].targetKey;

  if (key === undefined) {
    return ` (not linked: a ${kind} can attach to a person, company or opportunity)`;
  }

  const res = await execTwenty(reg, `create_one_${kind}_target`, {
    [`${kind}Id`]: childId,
    [key]: target.id,
    position: "first",
  });

  return res.ok
    ? ` on ${target.type} ${target.id}`
    : ` but linking it to ${target.type} ${target.id} failed — ${res.error}`;
}

async function createNoteOrTask(
  reg: IIntegrationRegistry,
  kind: "note" | "task",
  args: Record<string, unknown>,
  target: { type: TwentyType; id: string } | undefined
): Promise<string> {
  const title = str(args, "title").trim();
  const body = str(args, "body");

  if (title.length === 0) {
    return `twenty_write ${kind}: needs a \`title\``;
  }

  const payload: Record<string, unknown> = { title, position: "first" };

  if (body.trim().length > 0) {
    payload.bodyV2 = { markdown: body };
  }

  if (kind === "task") {
    const status = str(args, "status").trim().toUpperCase();

    if (status.length > 0 && !TASK_STATUS_NAMES.includes(status)) {
      return `twenty_write task: status must be one of ${TASK_STATUSES.join("|")}`;
    }

    payload.status = status.length > 0 ? status : "TODO";
    setIf(payload, "dueAt", str(args, "dueAt"));
  }

  const res = await execTwenty(reg, `create_one_${kind}`, payload);

  if (!res.ok) {
    return res.error;
  }

  const id = createdId(res);

  return `created ${kind} ${id}${await linkTarget(reg, kind, id, target)}`;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function needId(
  tool: string,
  op: string,
  args: Record<string, unknown>
): string | { error: string } {
  const id = str(args, "id").trim();

  if (!UUID_RE.test(id)) {
    return {
      error: `${tool} ${op}: needs the record \`id\` (a UUID from a search result)`,
    };
  }

  return id;
}

/**
 * Read the Twenty CRM: search, list recent, one record (with attached notes and
 * tasks), and the opportunity pipeline. Reads are policy-allowed in every mode
 * (integration_read); off ⇒ not advertised. Never throws.
 */
export async function doTwentyRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ITwentyDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  const reg = deps.registry;

  if (reg === undefined) {
    return reject(ctx, "twenty_read", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;

  ctx.report({ kind: "tool", task: ctx.task, message: `twenty_read ${op}` });

  if (op === "pipeline") {
    return pipeline(reg, max);
  }

  if (op !== "search" && op !== "list" && op !== "record") {
    return reject(
      ctx,
      "twenty_read",
      `unknown op '${op}' (use search|list|record|pipeline)`
    );
  }

  const t = typeArg(args);

  if (t === undefined) {
    return reject(ctx, "twenty_read", `${op}: needs \`type\` (${TYPE_NAMES})`);
  }

  if (op === "record") {
    const id = needId("twenty_read", op, args);

    return typeof id === "string"
      ? findOne(reg, t, id, max)
      : reject(ctx, "twenty_read", id.error);
  }

  if (op === "search" && str(args, "query").trim().length === 0) {
    return reject(
      ctx,
      "twenty_read",
      "search: needs a `query` (use op 'list' for recent records)"
    );
  }

  return findMany(reg, t, args, max);
}

/** The record a note/task is about, when `type` + `id` are given. */
function targetOf(
  args: Record<string, unknown>
): { type: TwentyType; id: string } | undefined | { error: string } {
  const hasId = str(args, "id").trim().length > 0;

  if (!hasId) {
    return undefined;
  }

  const type = typeArg(args);
  const id = needId("twenty_write", "note/task", args);

  if (type === undefined) {
    return {
      error: `twenty_write: to attach it, pass \`type\` (person|company|opportunity) with the \`id\``,
    };
  }

  return typeof id === "string" ? { type, id } : id;
}

/**
 * Write to the Twenty CRM: create / update people, companies and opportunities,
 * and add notes and tasks attached to them. Deliberately no delete. Gated by the
 * `twenty` capability AND the integration_write policy kind. Never throws.
 */
export async function doTwentyWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ITwentyDeps = { registry: ctx.mcpRegistry }
): Promise<string> {
  if (ctx.twenty !== true || deps.registry === undefined) {
    return reject(ctx, "twenty_write", CAPABILITY_OFF);
  }

  const reg = deps.registry;
  const op = str(args, "op");

  ctx.report({ kind: "tool", task: ctx.task, message: `twenty_write ${op}` });

  if (op === "note" || op === "task") {
    const target = targetOf(args);

    if (target !== undefined && "error" in target) {
      return reject(ctx, "twenty_write", target.error);
    }

    return createNoteOrTask(reg, op, args, target);
  }

  if (op !== "create" && op !== "update") {
    return reject(
      ctx,
      "twenty_write",
      `unknown op '${op}' (use create|update|note|task)`
    );
  }

  const type = typeArg(args);

  if (type === undefined) {
    return reject(
      ctx,
      "twenty_write",
      `${op}: needs \`type\` (person|company|opportunity)`
    );
  }

  if (op === "create") {
    return createRecord(reg, type, args);
  }

  const id = needId("twenty_write", op, args);

  return typeof id === "string"
    ? updateRecord(reg, type, id, args)
    : reject(ctx, "twenty_write", id.error);
}
