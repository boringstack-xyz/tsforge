/**
 * Model/provider setup for the CLI: registry resolution, wire-config
 * construction, context-window detection, and the `/model` command. Shared by
 * the REPL, one-shot runs, and the eval scripts so they all behave identically.
 */
import {
  PROVIDER_LIMITS,
  PROVIDER_DEFAULTS,
  OpenAICompatibleProvider,
  type IOpenAICompatibleConfig,
  type IProvider,
} from "../inference";
import {
  resolveActiveModel,
  setActiveModel,
  loadModelsConfig,
  resolveApiKey,
  modelByName,
  type IModelEntry,
  type IModelsConfig,
} from "../models-config";
import { isRecord } from "../lib/guards";
import { trace } from "../lib/trace";
import { addBootNote } from "./boot-banner";
import type { ICliArgs } from "./args";

/** The host:port of an API base URL, for the banner (falls back to the raw url). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch (err) {
    trace("cli.hostOf", err);

    return baseUrl;
  }
}

/** The active model id + endpoint host, from a wire-config (provider.config) or a
 *  registry entry — both carry `model` + `baseUrl`. */
export function modelInfo(src: { model: string; baseUrl: string }): {
  model: string;
  endpoint: string;
} {
  return { model: src.model, endpoint: hostOf(src.baseUrl) };
}

/** The model's real context window, read from the server's `/models`
 *  (`max_model_len` — vLLM/OpenAI-compatible). Best-effort: undefined if the
 *  endpoint is unreachable or doesn't report it (caller falls back). 3s cap so a
 *  dead endpoint can't stall CLI startup. */
export async function detectContextWindow(
  entry: IModelEntry
): Promise<number | undefined> {
  const headers: Record<string, string> = {};
  const key = resolveApiKey(entry);

  if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  }

  try {
    const res = await fetch(`${entry.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return undefined;
    }

    const data: unknown = await res.json();

    if (!isRecord(data) || !Array.isArray(data.data)) {
      return undefined;
    }

    const entries = data.data.filter(isRecord);
    const match = entries.find((e) => e.id === entry.model) ?? entries[0];
    // vLLM uses `max_model_len`; other servers expose `context_window` or
    // `max_position_embeddings` — accept whichever is present.
    const len =
      match?.max_model_len ??
      match?.context_window ??
      match?.max_position_embeddings;

    return typeof len === "number" && Number.isFinite(len) ? len : undefined;
  } catch (err) {
    trace("cli.detectContextWindow", err);

    return undefined;
  }
}

/** Parse a numeric env var, returning undefined for unset/blank/non-numeric
 *  input (never NaN — a NaN reaching the provider serializes to `null` in the
 *  request body and the model request fails confusingly). */
export function envNumber(name: string): number | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const value = Number(raw);

  return Number.isFinite(value) ? value : undefined;
}

/** Wire-config from a registry entry: API key resolved at use time (inline or
 *  via apiKeyEnv); env still tunes maxTokens/penalty. Shared by initial
 *  construction, `/model` hot-swap, and the interactive eval script — so they
 *  all behave identically. */
export function providerConfig(entry: IModelEntry): IOpenAICompatibleConfig {
  const repetitionPenalty = envNumber("TSFORGE_REPETITION_PENALTY");

  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens:
      entry.maxTokens ??
      envNumber("TSFORGE_MAX_TOKENS") ??
      PROVIDER_LIMITS.maxTokens,
    // OFF by default: a global repetition penalty also penalizes the rigid,
    // repetitive tool-call JSON tokens, which pushes the model to NARRATE
    // instead of emitting tool calls (→ no files written). The StreamGuard is
    // the targeted loop protection. Opt in only to experiment.
    ...(repetitionPenalty === undefined ? {} : { repetitionPenalty }),
    // Provider dialect + escape hatches — passed straight through so any
    // OpenAI-ish endpoint (DeepSeek, OpenAI o-series, custom gateways) works.
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    ...(entry.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: entry.reasoningEffort }),
    // Optional override only — guided decoding is auto-detected by endpoint
    // (local on, DeepSeek cloud off). Passed through when a model entry sets it.
    ...(entry.guidedDecoding === undefined
      ? {}
      : { guidedDecoding: entry.guidedDecoding }),
    ...(entry.extraBody === undefined ? {} : { extraBody: entry.extraBody }),
    ...(entry.extraHeaders === undefined
      ? {}
      : { extraHeaders: entry.extraHeaders }),
  };
}

export function makeProvider(entry: IModelEntry): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(providerConfig(entry));
}

export function resolveReviewProviders(cfg: IModelsConfig): IProvider[] {
  const envBase = process.env.TSFORGE_REVIEW_BASE_URL;
  const envModel = process.env.TSFORGE_REVIEW_MODEL;

  if (envBase !== undefined && envBase.length > 0 && envModel !== undefined) {
    const entry: IModelEntry = {
      baseUrl: envBase,
      model: envModel,
      apiKey: process.env.TSFORGE_REVIEW_API_KEY,
    };

    return [makeProvider(entry)];
  }

  if (envModel !== undefined && envModel.length > 0) {
    const entry = modelByName(cfg.models, envModel);

    return entry === undefined ? [] : [makeProvider(entry)];
  }

  return (cfg.reviewModels ?? [])
    .map((name) => modelByName(cfg.models, name))
    .filter((e): e is IModelEntry => e !== undefined)
    .map(makeProvider);
}

/** Clarify the two review config surfaces so users don't configure one and expect the other. */
export function warnReviewConfigSplit(cfg: IModelsConfig): void {
  const hasPanel =
    cfg.reviewPanel !== undefined && cfg.reviewPanel.reviewers.length > 0;
  const hasModels = (cfg.reviewModels?.length ?? 0) > 0;

  if (hasPanel && !hasModels) {
    addBootNote(
      "reviewPanel drives `tsforge harness-review` (pre-push); /review uses `reviewModels` — add reviewModels for interactive review.\n"
    );
  }
}

/** The active builder reviewing its own diff is allowed but worth calling out. */
export function warnSelfReview(reviewProviders: readonly IProvider[]): void {
  if (reviewProviders.length > 0) {
    return;
  }

  addBootNote(
    "⚠ no reviewModels configured — post-work /review uses the active builder model (self-review).\n"
  );
}

/** Catch the common footgun: a cloud baseUrl paired with the leftover qwen
 *  default `model`, which then 400s ("model not supported") on that host. */
export function warnDefaultModelOnRemote(entry: IModelEntry): void {
  let host: string;

  try {
    host = new URL(entry.baseUrl).hostname;
  } catch (err) {
    trace("cli.warnDefaultModel", err);

    return;
  }

  const remote = host !== "localhost" && host !== "127.0.0.1" && host !== "::1";

  if (remote && entry.model === PROVIDER_DEFAULTS.model) {
    addBootNote(
      `⚠ models.json: model is still "${PROVIDER_DEFAULTS.model}" (the default) but baseUrl is ${host} — set the entry's "model" to a name that host supports.\n`
    );
  }
}

/** Print the model registry with ★ on the active one (the `/model` listing). */
async function listModels(
  provider: OpenAICompatibleProvider,
  activeName: string
): Promise<void> {
  const cfg = await loadModelsConfig();
  const current = modelInfo(provider.config);

  process.stdout.write(
    `  active: ${activeName} — ${current.model} @ ${current.endpoint}\n`
  );

  for (const [name, e] of Object.entries(cfg.models)) {
    const mark = name === activeName ? "★" : " ";

    process.stdout.write(
      `  ${mark} ${name}  ${e.model} @ ${hostOf(e.baseUrl)}\n`
    );
  }

  if (activeName === "env") {
    process.stdout.write(
      "  (TSFORGE_* env is overriding the registry — unset it to use /model)\n"
    );
  }

  process.stdout.write("  switch with: /model <name>\n");
}

/** Handle `/model [name]`: no arg lists the registry; a name persists it as active
 *  and HOT-SWAPS the live provider. Returns the (possibly updated) active name +
 *  context window for the caller to thread back into the REPL state. */
export async function runModelCommand(opts: {
  arg: string;
  provider: OpenAICompatibleProvider;
  activeName: string;
  fallbackEntry: IModelEntry;
  contextWindow: number;
}): Promise<{ activeName: string; contextWindow: number }> {
  const { arg, provider, activeName, fallbackEntry, contextWindow } = opts;
  const wanted = arg.trim();

  if (wanted.length === 0) {
    await listModels(provider, activeName);

    return { activeName, contextWindow };
  }

  try {
    const next = await setActiveModel(wanted);
    const entry = next.models[wanted] ?? fallbackEntry;

    provider.reconfigure(providerConfig(entry));

    const window =
      entry.contextWindow ??
      (await detectContextWindow(entry)) ??
      contextWindow;
    const info = modelInfo(provider.config);

    process.stdout.write(
      `  ✓ switched to ${wanted} — ${info.model} @ ${info.endpoint} (context ${String(window)})\n`
    );

    return { activeName: wanted, contextWindow: window };
  } catch (err) {
    process.stdout.write(
      `  ${err instanceof Error ? err.message : String(err)}\n`
    );

    return { activeName, contextWindow };
  }
}

/** The model for a run: a recipe's named model (from ~/.tsforge/models.json) when
 *  set and known, else the active model. An unknown name warns and falls back. */
export async function modelForRun(
  args: ICliArgs
): Promise<{ name: string; entry: IModelEntry }> {
  if (args.model.length > 0) {
    const cfg = await loadModelsConfig();
    const entry = cfg.models[args.model];

    if (entry !== undefined) {
      return { name: args.model, entry };
    }

    process.stdout.write(
      `  recipe model '${args.model}' not in models.json — using the active model\n`
    );
  }

  return resolveActiveModel();
}
