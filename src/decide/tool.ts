/**
 * The plugin-facing surface: `createDecideTool` / `createDecideRuntime`.
 *
 * The engine is backend-agnostic; this file adapts the untrusted plugin `execute(input)` input
 * into a `DecideCall`, runs it, and produces the `{ output, content }` result the V2 plugin host
 * expects — `output` is the structured verdict Code Mode receives, `content` is the compact
 * durable transcript line(s).
 */

import { runDecide, type EngineDeps } from "./engine"
import { DECIDE_INPUT_SCHEMA, DECIDE_OUTPUT_SCHEMA } from "./schema"
import {
  DECIDE_NAMESPACE,
  DECIDE_TOOL_NAME,
  type DecideCall,
  type DecidePluginTool,
  type DecideVerdict,
  type Json,
} from "./types"

/** One compact, human-readable line per verdict for the durable transcript. */
export function formatVerdictLine(verdict: DecideVerdict): string {
  return `${verdict.id}: value=${JSON.stringify(verdict.value)} confidence=${verdict.confidence.toFixed(3)} escalate=${verdict.escalate}`
}

/** Validate the untrusted `execute(input)` payload into a `DecideCall`. */
export function parseDecideInput(input: unknown): DecideCall {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("decide: input must be an object")
  }
  const record = input as Record<string, unknown>
  if (record.state === undefined) throw new Error('decide: "state" is required')
  if (record.questions === undefined) throw new Error('decide: "questions" is required')

  const call: DecideCall = {
    state: record.state as Json,
    questions: record.questions as DecideCall["questions"],
  }
  if (record.escalateBelow !== undefined) {
    if (typeof record.escalateBelow !== "number") {
      throw new Error('decide: "escalateBelow" must be a number')
    }
    call.escalateBelow = record.escalateBelow
  }
  if (record.model !== undefined) {
    if (typeof record.model !== "string") throw new Error('decide: "model" must be a string')
    call.model = record.model
  }
  if (record.cache !== undefined) {
    if (typeof record.cache !== "boolean") throw new Error('decide: "cache" must be a boolean')
    call.cache = record.cache
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number") {
      throw new Error('decide: "timeoutMs" must be a number')
    }
    call.timeoutMs = record.timeoutMs
  }
  return call
}

const DESCRIPTION =
  "State-centric fuzzy judge (Liquid AI d1-ultra). Ask one or many atomic questions about a " +
  "single `state` and get per-question verdicts with normalized `confidence`, `value`, " +
  "`probabilities`/`p`, and an `escalate` flag. Batch related questions into one array call — " +
  "that is one judge request. Single question object in → single verdict object out; array in → " +
  "array out. Set `escalateBelow` to opt into escalation and read `verdict.reason`."

/** Same engine, Code Mode shaped, for the harness (no plugin host needed). */
export function createDecideRuntime(deps: EngineDeps): {
  call(call: DecideCall): Promise<DecideVerdict | DecideVerdict[]>
  tool: DecidePluginTool
} {
  const call = (decideCall: DecideCall): Promise<DecideVerdict | DecideVerdict[]> =>
    runDecide(deps, decideCall)

  const tool: DecidePluginTool = {
    name: DECIDE_TOOL_NAME,
    description: DESCRIPTION,
    input: DECIDE_INPUT_SCHEMA,
    output: DECIDE_OUTPUT_SCHEMA,
    options: { namespace: DECIDE_NAMESPACE, codemode: true, pinned: true },
    async execute(
      input: unknown,
      _context?: unknown,
    ): Promise<{ output: DecideVerdict | DecideVerdict[]; content: string }> {
      const decideCall = parseDecideInput(input)
      const output = await call(decideCall)
      const content = Array.isArray(output)
        ? output.map(formatVerdictLine).join("\n")
        : formatVerdictLine(output)
      return { output, content }
    },
  }

  return { call, tool }
}

/** The plugin tool definition, ready for `editor.add(...)`. */
export function createDecideTool(deps: EngineDeps): DecidePluginTool {
  return createDecideRuntime(deps).tool
}
