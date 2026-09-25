import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";

const IDLE_PROVIDER: IProvider = {
  async complete() {
    return { content: "ok", toolCalls: [] };
  },
};

async function withSystem(
  over: Parameters<typeof Session.create>[0] extends infer C
    ? Partial<C & { files: string[] }>
    : never,
  fn: (session: Session, system: () => string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));

  try {
    const session = await Session.create({
      provider: IDLE_PROVIDER,
      cwd: dir,
      files: ["**/*"],
      ...over,
    });

    const system = (): string => {
      const first = session.messages[0];

      return first?.role === "system" ? first.content : "";
    };

    await fn(session, system);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("drive-to-green system prompt (the build path's expert-TS contract)", () => {
  test("drive-to-green seeds the strict contract, not the chat framing", async () => {
    await withSystem(
      { executionMode: "drive-to-green" },
      async (_s, system) => {
        const s = system();

        // The expert-TS constitution is present.
        expect(s).toContain("driving ONE task to a GREEN gate");
        expect(s).toContain("no `any` and no `as`");
        expect(s).toContain("cognitive complexity at 20");
        // The chat framing must be ABSENT (it undercut the build path).
        expect(s).not.toContain("NOT every request is about that repository");
        expect(s).not.toContain("MATCH EFFORT");
      }
    );
  });

  test("command policy is single-voiced: don't self-run the gate", async () => {
    await withSystem(
      { executionMode: "drive-to-green" },
      async (_s, system) => {
        const s = system();

        // Drive-to-green forbids self-running the gate...
        expect(s).toContain("Do NOT run `tsc`");
        // ...and does NOT also advertise `run` as "execute any shell command … tsc"
        // (the chat line that made the model burn turns self-linting).
        expect(s).not.toContain(
          "execute any shell command — `ls`, `rg`, tests"
        );
      }
    );
  });

  test("chat mode still uses the chat framing (no regression)", async () => {
    await withSystem({ executionMode: "chat" }, async (_s, system) => {
      const s = system();

      expect(s).toContain("NOT every request is about code");
      expect(s).not.toContain("driving ONE task to a GREEN gate");
    });
  });

  test("task contract reflects LIVE scope after setScope (no stale edit-anything)", async () => {
    await withSystem(
      { executionMode: "drive-to-green" },
      async (session, system) => {
        // Created whole-repo → the contract says any file is editable.
        expect(system()).toContain("edit any file in the workspace");

        session.setScope(["apps/api/src/api/bookmark/**"]);

        // After the freeze the top-priority prompt MUST reflect the narrowed scope.
        const s = system();

        expect(s).toContain(
          "edit ONLY these paths — apps/api/src/api/bookmark/**"
        );
        expect(s).not.toContain("edit any file in the workspace");
      }
    );
  });
});
