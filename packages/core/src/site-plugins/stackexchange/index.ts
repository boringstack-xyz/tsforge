import type { ISitePlugin, ISiteRoute } from "../site-plugins.types";
import { createSeHandlers, seKey } from "./se.handlers";
import { SE_GUIDANCE, SE_TOOLS } from "./se.tools";
import { parseQuestionRef, SE_HOSTS } from "./se.urls";

export { createSeHandlers, seKey, type ISeDeps } from "./se.handlers";
export { SE_GUIDANCE, SE_MARKER } from "./se.tools";

/** A Stack Exchange question URL → se_question. */
export function routeSe(url: URL): ISiteRoute | null {
  const ref = parseQuestionRef(url.href, undefined);

  return ref === null
    ? null
    : {
        tool: "se_question",
        args: { question: String(ref.id), site: ref.site },
        key: seKey(ref),
        hint: `se_question question:"${String(ref.id)}" site:"${ref.site}"`,
      };
}

export const STACKEXCHANGE_PLUGIN: ISitePlugin = {
  id: "stackexchange",
  transport: "direct",
  hosts: SE_HOSTS,
  tools: SE_TOOLS,
  guidance: SE_GUIDANCE,
  handlers: createSeHandlers(),
  route: routeSe,
};
