import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "../lib/guards";
import { userConfigPath } from "./user-settings";

/** Pane + overlay actions configurable via `tui.keybindings`. */
export type TuiPaneAction =
  | "pane.toggle"
  | "pane.cycleSurface"
  | "pane.focus"
  | "pane.unfocus"
  | "pane.moveUp"
  | "pane.moveDown"
  | "keymap.show";

export const TUI_PANE_ACTIONS: readonly TuiPaneAction[] = [
  "pane.toggle",
  "pane.cycleSurface",
  "pane.focus",
  "pane.unfocus",
  "pane.moveUp",
  "pane.moveDown",
  "keymap.show",
];

/** Default chord strings (OS-agnostic logical names). */
export const DEFAULT_TUI_KEYBINDINGS: Readonly<
  Record<TuiPaneAction, readonly string[]>
> = {
  "pane.toggle": ["ctrl+g"],
  // f6 first: ctrl+shift+letter needs Kitty/modifyOtherKeys; many Mac terminals
  // (incl. Cursor) send plain "G" instead, which would type into the prompt.
  "pane.cycleSurface": ["f6", "ctrl+shift+g"],
  "pane.focus": ["tab"],
  "pane.unfocus": ["escape"],
  "pane.moveUp": ["up", "k"],
  "pane.moveDown": ["down", "j"],
  "keymap.show": ["?"],
};

const ESC = String.fromCharCode(27);

const NAMED_KEYS: Readonly<Record<string, readonly string[]>> = {
  tab: ["\t"],
  escape: [ESC],
  enter: ["\r"],
  up: [`${ESC}[A`, `${ESC}OA`],
  down: [`${ESC}[B`, `${ESC}OB`],
  f6: [`${ESC}[17~`],
};

const CSI_U = new RegExp(`^${ESC}\\[(\\d+);(\\d+)u$`, "u");
const XTERM_CTRL = new RegExp(`^${ESC}\\[27;(\\d+);(\\d+)~$`, "u");

function warnKeybinding(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function normalizeModifiers(parts: readonly string[]): {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly key: string;
} | null {
  const mods = new Set<string>();

  for (const part of parts.slice(0, -1)) {
    const p = part.trim().toLowerCase();

    if (p === "ctrl" || p === "shift" || p === "alt" || p === "meta") {
      mods.add(p);
      continue;
    }

    warnKeybinding(
      `tsforge: unknown keybinding modifier "${part}" — entry dropped`
    );

    return null;
  }

  const key = parts[parts.length - 1]?.trim().toLowerCase() ?? "";

  if (key.length === 0) {
    return null;
  }

  return {
    ctrl: mods.has("ctrl"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    meta: mods.has("meta"),
    key,
  };
}

function kittyMods(
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean
): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (meta ? 8 : 0);
}

function ctrlLetterByte(key: string): string | null {
  if (key.length !== 1) {
    return null;
  }

  const code = key.toLowerCase().charCodeAt(0);

  if (code >= 97 && code <= 122) {
    return String.fromCharCode(code - 96);
  }

  if (key === "\\") {
    return String.fromCharCode(28);
  }

  if (key === "[") {
    return String.fromCharCode(27);
  }

  if (key === "]") {
    return String.fromCharCode(29);
  }

  return null;
}

function encodeChord(chord: string): readonly string[] {
  const trimmed = chord.trim();

  if (trimmed.length === 0) {
    return [];
  }

  if (!trimmed.includes("+")) {
    const named = NAMED_KEYS[trimmed.toLowerCase()];

    if (named !== undefined) {
      return named;
    }

    if (trimmed === "?") {
      return ["?"];
    }

    return [trimmed.length === 1 ? trimmed : trimmed];
  }

  const parts = trimmed.split("+").map((p) => p.trim());
  const parsed = normalizeModifiers(parts);

  if (parsed === null) {
    return [];
  }

  const { ctrl, shift, alt, meta, key } = parsed;

  if (ctrl && !shift && !alt && !meta) {
    const legacy = ctrlLetterByte(key);

    if (legacy !== null) {
      const codepoint = key === "\\" ? 92 : key.toLowerCase().charCodeAt(0);
      const mods = kittyMods(true, false, false, false);

      return [
        legacy,
        `${ESC}[${String(codepoint)};${String(mods)}u`,
        `${ESC}[27;${String(mods)};${String(codepoint)}~`,
      ];
    }
  }

  if (ctrl && shift && !alt && !meta && key.length === 1) {
    const codepoint = key.toLowerCase().charCodeAt(0);
    const mods = kittyMods(true, true, false, false);

    return [
      `${ESC}[${String(codepoint)};${String(mods)}u`,
      `${ESC}[27;${String(mods)};${String(codepoint)}~`,
    ];
  }

  const named = NAMED_KEYS[key];

  if (named !== undefined && !ctrl && !shift && !alt && !meta) {
    return named;
  }

  warnKeybinding(
    `tsforge: unsupported keybinding chord "${chord}" — entry dropped`
  );

  return [];
}

export interface IResolvedTuiKeybindings {
  /** Chord string as stored in config (for display in the ? overlay). */
  readonly display: Readonly<Record<TuiPaneAction, readonly string[]>>;
  /** action → byte sequences that match incoming stdin after peeling. */
  readonly matchers: ReadonlyMap<string, TuiPaneAction>;
}

function mergeBindingMaps(
  project: Readonly<Partial<Record<TuiPaneAction, string | readonly string[]>>>,
  user: Readonly<Partial<Record<TuiPaneAction, string | readonly string[]>>>
): Readonly<Record<TuiPaneAction, readonly string[]>> {
  const out: Record<TuiPaneAction, readonly string[]> = {
    ...DEFAULT_TUI_KEYBINDINGS,
  };

  for (const action of TUI_PANE_ACTIONS) {
    const projectVal = project[action];
    const userVal = user[action];
    const raw = userVal ?? projectVal;

    if (raw === undefined) {
      continue;
    }

    const chords = typeof raw === "string" ? [raw] : [...raw];
    const valid: string[] = [];

    for (const chord of chords) {
      if (typeof chord !== "string" || chord.trim().length === 0) {
        warnKeybinding(
          `tsforge: invalid keybinding for ${action} — entry dropped`
        );
        continue;
      }

      if (encodeChord(chord).length === 0) {
        continue;
      }

      valid.push(chord.trim());
    }

    if (valid.length > 0) {
      out[action] = valid;
    }
  }

  return out;
}

export function resolveTuiKeybindings(
  project?: Readonly<
    Partial<Record<TuiPaneAction, string | readonly string[]>>
  >,
  user?: Readonly<Partial<Record<TuiPaneAction, string | readonly string[]>>>
): IResolvedTuiKeybindings {
  const display = mergeBindingMaps(project ?? {}, user ?? {});
  const matchers = new Map<string, TuiPaneAction>();

  for (const action of TUI_PANE_ACTIONS) {
    for (const chord of display[action]) {
      for (const seq of encodeChord(chord)) {
        matchers.set(seq, action);
      }
    }
  }

  return { display, matchers };
}

/** Map Kitty CSI-u / xterm modifyOtherKeys to legacy ctrl bytes when possible. */
export function normalizeInputSeq(seq: string): string {
  const csiU = CSI_U.exec(seq);

  if (csiU !== null) {
    const codepoint = Number.parseInt(csiU[1] ?? "", 10);
    const mods = Number.parseInt(csiU[2] ?? "", 10);
    const base = Math.max(0, mods - 1);
    const ctrl = (base & 4) !== 0;
    const shift = (base & 1) !== 0;

    if (ctrl && !shift && codepoint === 103) {
      return "\x07";
    }

    if (ctrl && !shift && codepoint === 111) {
      return "\x0f";
    }

    if (ctrl && shift && codepoint === 103) {
      return `${ESC}[${String(codepoint)};${String(mods)}u`;
    }
  }

  const xterm = XTERM_CTRL.exec(seq);

  if (xterm !== null) {
    const mods = Number.parseInt(xterm[1] ?? "", 10);
    const codepoint = Number.parseInt(xterm[2] ?? "", 10);
    const base = Math.max(0, mods - 1);
    const ctrl = (base & 4) !== 0;
    const shift = (base & 1) !== 0;

    if (ctrl && !shift && codepoint === 103) {
      return "\x07";
    }

    if (ctrl && !shift && codepoint === 111) {
      return "\x0f";
    }
  }

  return seq;
}

export function matchPaneAction(
  seq: string,
  bindings: IResolvedTuiKeybindings
): TuiPaneAction | null {
  const direct = bindings.matchers.get(seq);

  if (direct !== undefined) {
    return direct;
  }

  const normalized = normalizeInputSeq(seq);

  if (normalized !== seq) {
    return bindings.matchers.get(normalized) ?? null;
  }

  return null;
}

function parseKeybindingsBlock(
  value: unknown
): Partial<Record<TuiPaneAction, string | readonly string[]>> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    warnKeybinding('tsforge: "tui.keybindings" must be an object — ignored');

    return {};
  }

  const out: Partial<Record<TuiPaneAction, string | readonly string[]>> = {};

  for (const action of TUI_PANE_ACTIONS) {
    const raw = value[action];

    if (raw === undefined) {
      continue;
    }

    if (typeof raw === "string") {
      out[action] = raw;
      continue;
    }

    if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
      out[action] = raw;
      continue;
    }

    warnKeybinding(`tsforge: invalid keybinding for ${action} — entry dropped`);
  }

  return out;
}

export function parseProjectTuiKeybindings(config: {
  readonly tui?: { readonly keybindings?: unknown };
}): Partial<Record<TuiPaneAction, string | readonly string[]>> {
  return parseKeybindingsBlock(config.tui?.keybindings);
}

/** Load `~/.tsforge/config.json` keybindings (user-global overrides). */
export function loadUserTuiKeybindings(): Partial<
  Record<TuiPaneAction, string | readonly string[]>
> {
  const path = userConfigPath();

  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

    if (!isRecord(parsed)) {
      return {};
    }

    const tui = parsed.tui;

    if (!isRecord(tui)) {
      return {};
    }

    return parseKeybindingsBlock(tui.keybindings);
  } catch {
    warnKeybinding(
      "tsforge: could not read ~/.tsforge/config.json — using defaults"
    );

    return {};
  }
}

/** @deprecated Use {@link normalizeInputSeq}. */
export function normalizePaneControlSeq(seq: string): string {
  return normalizeInputSeq(seq);
}
