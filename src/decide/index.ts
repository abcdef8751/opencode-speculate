/**
 * Public surface of the `decide` engine — re-exports exactly the contract's §1 vocabulary.
 * `src/index.ts` (the plugin entry, orchestrator-owned) imports only from here.
 */

export type {
  Json,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  DecideQuestion,
  DecideCall,
  DecideVerdict,
  StoragePort,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneAnswer,
  SystemOneUsage,
  SystemOneResult,
  Judge,
  DecidePluginTool,
} from "./types"

export { DECIDE_TOOL_NAME, DECIDE_NAMESPACE } from "./types"
export { DECIDE_INPUT_SCHEMA, DECIDE_OUTPUT_SCHEMA } from "./schema"
export {
  createSystemOneJudge,
  DEFAULT_SYSTEMONE_BASE_URL,
  DEFAULT_SYSTEMONE_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
} from "./systemone"
export type { CreateSystemOneJudgeOptions } from "./systemone"
// Frozen §1 names, kept as aliases (the backend is no longer Jev-specific).
export { createJevJudge, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from "./jev"
export type { CreateJevJudgeOptions } from "./jev"
export { createDecideTool, createDecideRuntime, parseDecideInput, formatVerdictLine } from "./tool"
