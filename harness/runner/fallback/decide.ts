/**
 * FALLBACK DECIDE RUNTIME — re-export of `./decide-shim.ts`.
 *
 * Used only while `src/decide/index.ts` (worker A) does not exist in this worktree.
 *
 * OWNER: worker D1 (temporary).
 */

export { createDecideRuntime } from "./decide-shim.ts";
