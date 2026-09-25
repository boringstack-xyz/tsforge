import { COMMANDS, takesArg } from "./commands";

export type CapabilityKind = "command" | "wizard";

export type CapabilityInvoke =
  | { readonly type: "run"; readonly command: string }
  | { readonly type: "prefill"; readonly command: string }
  | { readonly type: "wizard"; readonly opener: "scaffold" | "recipe" };

export interface ICapability {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly describe: string;
  readonly kind: CapabilityKind;
  readonly invoke?: CapabilityInvoke;
}

export interface ICapabilityDeps {
  readonly hasRecipes: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const UNDERSTAND_YOUR_CODE = "Understand your code";
const STEER_THE_SESSION = "Steer the session";
const SESSION_AND_COST = "Session & cost";

// ── Command group mapping ────────────────────────────────────────────────────

// Slash commands whose discovery home in the browser is a WIZARD row, not a
// generated command row. `/scaffold` opens the scaffold wizard: the browser must
// route it through the awaited wizard path (`openWizard`), never a fire-and-forget
// `void runLine`, or the wizard and the editor both consume stdin (the double-typed
// -text failure). So it gets NO command-capability row here — the "Build something
// new" wizard row (below) is its single browser home. It stays in COMMANDS for the
// `/help` text, the `/` palette, and typed dispatch (all of which are already safe).
export const COMMAND_WIZARD_HOME: Readonly<
  Record<string, "scaffold" | "recipe">
> = {
  "/scaffold": "scaffold",
};

const COMMAND_TO_GROUP: Readonly<Record<string, string>> = {
  "/review": UNDERSTAND_YOUR_CODE,
  "/map": UNDERSTAND_YOUR_CODE,
  "/plan": STEER_THE_SESSION,
  "/gate": STEER_THE_SESSION,
  "/files": STEER_THE_SESSION,
  "/model": STEER_THE_SESSION,
  "/config": STEER_THE_SESSION,
  "/browser": STEER_THE_SESSION,
  "/setup": STEER_THE_SESSION,
  "/sessions": SESSION_AND_COST,
  "/compact": SESSION_AND_COST,
  "/clear": SESSION_AND_COST,
  "/cost": SESSION_AND_COST,
  "/metrics": SESSION_AND_COST,
  "/trace": SESSION_AND_COST,
  "/memory": SESSION_AND_COST,
  "/remember": SESSION_AND_COST,
};

// ── Builders ─────────────────────────────────────────────────────────────────

function commandCapabilities(): ICapability[] {
  const exempt = new Set(["/help", "/exit"]);
  const capabilities: ICapability[] = [];

  for (const spec of COMMANDS) {
    // Skip the browser-exempt commands and any command whose home is a wizard row.
    if (
      exempt.has(spec.name) ||
      Object.hasOwn(COMMAND_WIZARD_HOME, spec.name)
    ) {
      continue;
    }

    const group = COMMAND_TO_GROUP[spec.name] ?? SESSION_AND_COST;
    const invoke: CapabilityInvoke = {
      type: takesArg(spec) ? "prefill" : "run",
      command: spec.name,
    };

    capabilities.push({
      id: spec.name,
      group,
      label: spec.summary,
      describe: spec.summary,
      kind: "command",
      invoke,
    });
  }

  return capabilities;
}

function wizardCapabilities(deps: ICapabilityDeps): ICapability[] {
  const capabilities: ICapability[] = [
    {
      id: "scaffold",
      group: "Build something new",
      label: "Scaffold a project",
      describe:
        "Stand up a new project — boringstack (full stack), astro (static site), or phaser (game).",
      kind: "wizard",
      invoke: { type: "wizard", opener: "scaffold" },
    },
  ];

  if (deps.hasRecipes) {
    capabilities.push({
      id: "recipe",
      group: "Build something new",
      label: "Run a recipe",
      describe: "Run a saved build+gate flow from .tsforge/recipes.",
      kind: "wizard",
      invoke: { type: "wizard", opener: "recipe" },
    });
  }

  return capabilities;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildCapabilities(deps: ICapabilityDeps): ICapability[] {
  return [...commandCapabilities(), ...wizardCapabilities(deps)];
}

export function capabilityCommandNames(caps: readonly ICapability[]): string[] {
  const names: string[] = [];

  for (const cap of caps) {
    if (cap.invoke?.type === "run" || cap.invoke?.type === "prefill") {
      names.push(cap.invoke.command);
    }
  }

  return names;
}
