/**
 * Arms B and C — one model call producing one Code Mode program, executed over the same `ToolBox`.
 *
 *   B: file/shell tools only.
 *   C: the same, plus `tools.typesafe.decide` registered through `createDecideRuntime` (§1), with
 *      the task's `escalationPrompt` appended to the prompt.
 *
 * OWNER: worker D1.
 */

import { calculateScriptFailures, executeScript } from "../../sandbox/codemode.ts";
import { addUsage } from "../../pricing.ts";
import type { ArmID, ArmResult, ChatMessage } from "../../types.ts";
import { armClock, armSystemMessage, toolsForArm, type ArmContext } from "./context.ts";
import { applyDecideState, attributeCost, decideLogSink, emptyResult, zeroUsage, type DecideLogState } from "../results.ts";
import { createMemoryStorage } from "../storage.ts";

/** Extra instruction appended to arm C's prompt when the task does not supply one. */
export const DEFAULT_ESCALATION_PROMPT =
  "When decide() returns a verdict with `escalate === true`, log the reason and pass the last tool output as the decision state.";

/** Pulls the program out of a model response: an `execute` tool call, else the (fenced) text. */
export function extractScript(text: string, toolCalls: readonly { name: string; input: unknown }[]): string | undefined {
  const execute = toolCalls.find((call) => call.name === "execute");
  if (execute !== undefined) {
    const input = execute.input;
    if (typeof input === "object" && input !== null) {
      const code = (input as { code?: unknown }).code;
      if (typeof code === "string" && code.trim().length > 0) return code.trim();
    }
  }
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(text);
  const body = fence?.[1] ?? text;
  const trimmed = body.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The user prompt for a script arm.
 *
 * The arm-C sentence naming `tools.typesafe.decide({ state, questions })` is deliberately kept
 * verbatim: besides teaching the model the path, it is the prompt signal a driver can use to tell
 * arm C from arm B (arm B's prompt never mentions `decide`) — see `./context.ts` and the
 * "Driver conventions" section of `harness/README.md`. Changing that path or its spelling changes
 * how a driver detects arm C.
 */
export function scriptPrompt(arm: ArmID, ctx: ArmContext): string {
  const parts = [ctx.task.scriptPrompt];
  if (arm === "C") {
    parts.push(ctx.task.escalationPrompt ?? DEFAULT_ESCALATION_PROMPT);
    parts.push("The judge tool is available as `tools.typesafe.decide({ state, questions })`.");
  }
  return parts.join("\n\n");
}

export async function runScriptArm(arm: "B" | "C", ctx: ArmContext): Promise<ArmResult> {
  const result = emptyResult(arm, ctx.task.id, ctx.runIndex);
  const clock = armClock(ctx);
  const started = clock();

  const messages: ChatMessage[] = [
    { role: "system", text: armSystemMessage(arm, ctx.task, ctx.runIndex) },
    { role: "user", text: scriptPrompt(arm, ctx) },
  ];
  const tools = toolsForArm(arm, ctx);

  const decideState: DecideLogState = { decideCalls: [], escalations: 0, notes: [] };
  let usage = zeroUsage();

  try {
    const response = await ctx.driver.complete({
      messages,
      tools,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    result.turns = 1;
    usage = addUsage(usage, response.usage);

    const code = extractScript(response.text, response.toolCalls);
    if (code === undefined) {
      result.scriptFailures = 1;
      result.notes.push("driver returned no Code Mode program (empty text and no `execute` tool call)");
      result.transcript = response.text;
    } else {
      result.transcript = code;
      let decideTool;
      if (arm === "C") {
        if (ctx.createDecideRuntime === undefined || ctx.judge === undefined) {
          throw new Error("arm C requires `createDecideRuntime` and a `judge` in the arm context");
        }
        const runtime = ctx.createDecideRuntime({
          judge: ctx.judge,
          storage: createMemoryStorage(),
          log: decideLogSink(decideState),
        });
        decideTool = runtime.tool;
      }

      const execution = await executeScript({
        toolbox: ctx.toolbox,
        ...(decideTool === undefined ? {} : { decide: decideTool }),
        code,
        ...(ctx.limits === undefined ? {} : { limits: ctx.limits }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });

      result.logs = execution.logs;
      result.toolCalls = execution.toolCalls;
      result.toolFailures = execution.toolFailures;
      result.scriptFailures = calculateScriptFailures(execution);
      result.ok = execution.ok;
      if (execution.ok) {
        result.notes.push(`script returned: ${JSON.stringify(execution.value)?.slice(0, 500) ?? "undefined"}`);
      } else {
        result.notes.push(`script failed (${execution.errorKind ?? "unknown"}): ${execution.errorMessage ?? ""}`.trim());
      }
      for (const warning of execution.warnings) result.notes.push(`warning: ${warning}`);
    }

    result.usage = attributeCost(usage, ctx.modelId ?? ctx.driver.id);
  } catch (error) {
    result.usage = attributeCost(usage, ctx.modelId ?? ctx.driver.id);
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }

  applyDecideState(result, decideState);

  const correctness = await ctx.task.verify(ctx.toolbox.dir).catch((error) => ({
    passed: false,
    detail: `verify() threw: ${error instanceof Error ? error.message : String(error)}`,
  }));
  result.correctness = correctness;
  result.wallMs = Math.max(0, clock() - started);
  return result;
}

export function runArmB(ctx: ArmContext): Promise<ArmResult> {
  return runScriptArm("B", ctx);
}

export function runArmC(ctx: ArmContext): Promise<ArmResult> {
  return runScriptArm("C", ctx);
}
