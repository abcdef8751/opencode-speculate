export { runArmA } from "./arm-a.ts";
export { runArmB, runArmC, runScriptArm, extractScript, scriptPrompt, DEFAULT_ESCALATION_PROMPT } from "./arm-script.ts";
export { EXECUTE_TOOL, armClock, armSystemMessage, parseArmMarker, toolsForArm } from "./context.ts";
export type { ArmContext, ArmMarker } from "./context.ts";

import type { ArmID, ArmResult } from "../../types.ts";
import { runArmA } from "./arm-a.ts";
import { runArmB, runArmC } from "./arm-script.ts";
import type { ArmContext } from "./context.ts";

/** Dispatch one arm by id. */
export function runArm(arm: ArmID, ctx: ArmContext): Promise<ArmResult> {
  switch (arm) {
    case "A":
      return runArmA(ctx);
    case "B":
      return runArmB(ctx);
    case "C":
      return runArmC(ctx);
  }
}
