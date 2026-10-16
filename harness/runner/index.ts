export { runHarness } from "./orchestrate.ts";
export type { RunHarnessOptions, RunOutcome } from "./orchestrate.ts";
export { loadSources, describeOrigins } from "./sources.ts";
export type { Sources, SeamOrigin } from "./sources.ts";
export { createMemoryStorage } from "./storage.ts";
export type { MemoryStorage } from "./storage.ts";
export {
  createScratchDir,
  removeScratchDir,
  defaultScratchBase,
  repoRoot,
} from "./scratch.ts";
export type { ScratchRequest } from "./scratch.ts";
export {
  DEFAULT_MAX_TURNS,
  applyDecideState,
  attributeCost,
  decideLogSink,
  emptyResult,
  toDecideCallRecord,
  zeroUsage,
} from "./results.ts";
export type { DecideLogState } from "./results.ts";
export {
  DEFAULT_ESCALATION_PROMPT,
  EXECUTE_TOOL,
  armClock,
  armSystemMessage,
  extractScript,
  parseArmMarker,
  runArm,
  runArmA,
  runArmB,
  runArmC,
  runScriptArm,
  scriptPrompt,
  toolsForArm,
} from "./arms/index.ts";
export type { ArmContext, ArmMarker } from "./arms/index.ts";
