/**
 * Shared context and conventions for the three measurement arms.
 *
 * ## How the three arms look to a driver
 *
 * `ModelDriver.complete(req)` (frozen in `harness/types.ts`) carries no arm identifier, so the
 * runner makes the arms distinguishable from the request itself:
 *
 *  1. **tool list** — arm A gets the real `ToolBox.descriptors`; arms B/C get a single `execute`
 *     tool (`EXECUTE_TOOL`). This is the primary signal.
 *  2. **prompt** — arm C's prompt names `tools.typesafe.decide(...)` (see `scriptPrompt()`); arms
 *     B/C are told to answer with one Code Mode program and arm A to call tools turn by turn.
 *  3. **response shape** — arms B/C expect the program in `ModelResponse.text` or in an `execute`
 *     tool call; arm A expects `toolCalls[]`.
 *
 * The first system message additionally starts with an **informational** marker
 * `harness:arm=<A|B|C>;task=<id>;run=<n>` (`armSystemMessage`). It exists for transcript
 * readability, for `parseArmMarker()` in tests, and because a driver that picks its canned response
 * by task id finds the id there — but **no driver is required to parse it**, and the harness never
 * depends on a driver doing so. See `harness/README.md` § "Driver conventions".
 *
 * OWNER: worker D1.
 */

import type { ModelDriver, TaskDef, ToolDescriptor, ToolBox, ArmID } from "../../types.ts";
import type { DecideRuntimeFactory, Judge } from "../../sandbox/decide-port.ts";
import type { ScriptLimits } from "../../sandbox/codemode.ts";

/** The synthetic tool the script arms get instead of the direct tool list. */
export const EXECUTE_TOOL: ToolDescriptor = {
  name: "execute",
  description:
    "Execute one Code Mode program against the sandbox. Pass the program source as `code`. The program runs once; its return value and console output come back.",
  input: {
    type: "object",
    properties: { code: { type: "string", description: "JavaScript program source." } },
    required: ["code"],
    additionalProperties: false,
  },
};

export interface ArmContext {
  driver: ModelDriver;
  toolbox: ToolBox;
  task: TaskDef;
  runIndex: number;
  /** Main-model turn budget for arm A. */
  maxTurns: number;
  /** Code Mode resource limits for arms B/C. */
  limits?: Partial<ScriptLimits> | undefined;
  signal?: AbortSignal | undefined;
  /** Arm C only: `createDecideRuntime` from `src/decide/index.ts` (§1). */
  createDecideRuntime?: DecideRuntimeFactory | undefined;
  /** Arm C only: the `Judge` the decide runtime should use. */
  judge?: Judge | undefined;
  /** Model id used for cost attribution when the driver reports no `costUsd`. */
  modelId?: string | undefined;
  /** Injectable clock (tests). Defaults to `performance.now`. */
  now?: (() => number) | undefined;
}

/**
 * The first system message. The leading `harness:arm=…` marker is **informational** (transcript
 * readability + task-id discoverability); drivers are not required to parse it — see the module
 * header. The sentence after it is prompt guidance for a real model, not protocol.
 */
export function armSystemMessage(arm: ArmID, task: TaskDef, runIndex: number): string {
  const marker = `harness:arm=${arm};task=${task.id};run=${runIndex}`;
  if (arm === "A") {
    return `${marker}\nYou are measured in ARM A (direct tool loop): call tools one turn at a time until the task is done.`;
  }
  return `${marker}\nYou are measured in ARM ${arm} (single Code Mode script): answer with ONE Code Mode program (a \`code\` string / \`execute\` call), not with turn-by-turn tool calls.`;
}

export interface ArmMarker {
  arm: ArmID;
  taskId: string;
  runIndex: number;
}

const ARM_MARKER = /harness:arm=(A|B|C);task=([^;\s]+);run=(\d+)/;

/** Reads the arm marker a driver needs to pick the right canned behaviour. */
export function parseArmMarker(text: string | undefined): ArmMarker | undefined {
  if (text === undefined) return undefined;
  const match = ARM_MARKER.exec(text);
  if (match === null) return undefined;
  return { arm: match[1] as ArmID, taskId: match[2]!, runIndex: Number(match[3]) };
}

/** Monotonic-ish millisecond clock; injectable for tests. */
export function armClock(ctx: ArmContext): () => number {
  if (ctx.now !== undefined) return ctx.now;
  return () => performance.now();
}

/** The tool list a driver sees for the given arm. */
export function toolsForArm(arm: ArmID, ctx: ArmContext): readonly ToolDescriptor[] {
  return arm === "A" ? ctx.toolbox.descriptors : [EXECUTE_TOOL];
}
