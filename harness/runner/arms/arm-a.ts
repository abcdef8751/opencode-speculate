/**
 * Arm A — the direct tool loop: `ModelDriver.complete()` in a loop, each returned `toolCalls[]`
 * executed by `ToolBox.call(name, input)` and appended to the transcript as a tool message.
 * Stops when a turn returns no tool calls, or at `maxTurns`. One turn per `complete()`.
 *
 * OWNER: worker D1.
 */

import { addUsage } from "../../pricing.ts";
import type { ArmResult, ChatMessage } from "../../types.ts";
import { armClock, armSystemMessage, toolsForArm, type ArmContext } from "./context.ts";
import { attributeCost, emptyResult, zeroUsage } from "../results.ts";

/** Renders a tool result (or failure) as the tool message text the model sees next turn. */
function toolMessageText(name: string, value: unknown): string {
  return `tool ${name} returned:\n${JSON.stringify(value, null, 2) ?? "undefined"}`;
}

export async function runArmA(ctx: ArmContext): Promise<ArmResult> {
  const result = emptyResult("A", ctx.task.id, ctx.runIndex);
  const clock = armClock(ctx);
  const started = clock();

  const messages: ChatMessage[] = [
    { role: "system", text: armSystemMessage("A", ctx.task, ctx.runIndex) },
    { role: "user", text: ctx.task.prompt },
  ];
  const tools = toolsForArm("A", ctx);

  let usage = zeroUsage();
  let finalText = "";

  try {
    while (result.turns < ctx.maxTurns) {
      if (ctx.signal?.aborted) throw new Error("aborted");
      const response = await ctx.driver.complete({
        messages,
        tools,
        maxTurns: ctx.maxTurns,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      result.turns += 1;
      usage = addUsage(usage, response.usage);
      finalText = response.text;
      messages.push({
        role: "assistant",
        text: response.text,
        ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
      });

      if (response.toolCalls.length === 0) break;

      for (const call of response.toolCalls) {
        result.toolCalls.push(call.name);
        try {
          const value = await ctx.toolbox.call(call.name, call.input, ctx.signal);
          messages.push({ role: "tool", toolName: call.name, text: toolMessageText(call.name, value) });
        } catch (error) {
          result.toolFailures += 1;
          const message = error instanceof Error ? error.message : String(error);
          result.notes.push(`tool ${call.name} failed: ${message}`);
          messages.push({ role: "tool", toolName: call.name, text: `tool ${call.name} failed: ${message}` });
        }
      }
    }

    if (result.turns >= ctx.maxTurns && result.turns > 0) {
      result.notes.push(`stopped at maxTurns=${ctx.maxTurns}`);
    }

    result.usage = attributeCost(usage, ctx.modelId ?? ctx.driver.id);
    result.transcript = finalText;
    result.ok = true;
  } catch (error) {
    result.usage = attributeCost(usage, ctx.modelId ?? ctx.driver.id);
    result.transcript = finalText;
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }

  const correctness = await ctx.task.verify(ctx.toolbox.dir).catch((error) => ({
    passed: false,
    detail: `verify() threw: ${error instanceof Error ? error.message : String(error)}`,
  }));
  result.correctness = correctness;
  result.wallMs = Math.max(0, clock() - started);
  return result;
}
