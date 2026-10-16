/**
 * FALLBACK TASKS — re-export of the scenarios in `./scenario.ts`.
 *
 * Used only while `harness/tasks/index.ts` (worker D2) does not exist in this worktree.
 *
 * OWNER: worker D1 (temporary).
 */

export { FALLBACK_TASKS as TASKS, getFallbackTask as getTask } from "./scenario.ts";
export { FALLBACK_SCENARIOS, scenarioFor, FALLBACK_JUDGE_ANSWERS } from "./scenario.ts";
export type { FallbackScenario, JudgeAnswer } from "./scenario.ts";
