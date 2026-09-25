import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$TSFORGE_HOME/.tsforge/browser-token` (else under the home dir). */
export function bridgeTokenPath(): string {
  return join(
    process.env.TSFORGE_HOME ?? homedir(),
    ".tsforge",
    "browser-token"
  );
}

const MIN_TOKEN_LENGTH = 16;

/** The pairing secret the extension sends in its hello frame. Created once
 *  (0600, 24 random bytes, base64url) and reused, so pairing survives restarts. */
export async function loadOrCreateBridgeToken(
  path: string = bridgeTokenPath()
): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();

    if (existing.length >= MIN_TOKEN_LENGTH) {
      return existing;
    }
  } catch {
    // absent — create below
  }

  const token = randomBytes(24).toString("base64url");

  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);

  return token;
}

/** The existing token, or null — for display (/browser); never creates one. */
export async function readBridgeToken(
  path: string = bridgeTokenPath()
): Promise<string | null> {
  try {
    const token = (await readFile(path, "utf8")).trim();

    return token.length >= MIN_TOKEN_LENGTH ? token : null;
  } catch {
    return null;
  }
}
