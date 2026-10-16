/**
 * DEV SHIM — a small, offline implementation of the `decide` runtime seam (§1) used ONLY when
 * `src/decide/index.ts` (worker A) is not present in this worktree. `../sources.ts` prefers the
 * real module whenever it exists; this file exists so the harness can run arm C offline before the
 * merge. It is *not* the contract implementation and must not be used as a reference for §1.
 *
 * OWNER: worker D1 (temporary).
 */

import { createHash } from "node:crypto";
import type { Json } from "../../types.ts";
import {
  DECIDE_NAMESPACE,
  DECIDE_TOOL_NAME,
  type DecideCall,
  type DecidePluginTool,
  type DecideQuestion,
  type DecideRuntime,
  type DecideRuntimeDeps,
  type DecideVerdict,
  type SystemOneAnswer,
  type SystemOneQuestion,
  type SystemOneRequest,
} from "../../sandbox/decide-port.ts";

export const SHIM_DECIDE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    state: { description: "Text or JSON to judge. Keep it self-contained." },
    questions: { oneOf: [{ type: "object" }, { type: "array", items: { type: "object" }, minItems: 1 }] },
    escalateBelow: { type: "number" },
    model: { type: "string" },
    cache: { type: "boolean", default: true },
    timeoutMs: { type: "number" },
  },
  required: ["state", "questions"],
  additionalProperties: false,
};

export const SHIM_DECIDE_OUTPUT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { enum: ["noul", "choice", "score"] },
        value: {},
        confidence: { type: "number" },
        modelId: { type: "string" },
        latencyMs: { type: "number" },
        cached: { type: "boolean" },
        escalate: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["id", "mode", "value", "confidence", "modelId", "latencyMs", "cached", "escalate"],
    },
    { type: "array", items: { type: "object" } },
  ],
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function toSystemOneQuestion(question: DecideQuestion): SystemOneQuestion {
  switch (question.mode) {
    case "noul":
      return { type: "noul", criteria: { true: question.criteria.true, false: question.criteria.false }, ...(question.criterion === undefined ? {} : { instructions: question.criterion }) };
    case "choice":
      return { type: "choice", criteria: { ...question.options }, ...(question.criterion === undefined ? {} : { instructions: question.criterion }) };
    case "score":
      return { type: "score", criteria: [...question.levels], ...(question.criterion === undefined ? {} : { instructions: question.criterion }) };
  }
}

function confidenceFor(question: DecideQuestion, answer: SystemOneAnswer | undefined): { confidence: number; reason?: string; value: DecideVerdict["value"] } {
  if (answer === undefined) return { confidence: 0, reason: `no answer returned for "${question.id}"`, value: question.mode === "noul" ? false : 0 };
  if (question.mode === "noul") {
    const p = answer.noul;
    if (typeof p !== "number" || !Number.isFinite(p)) return { confidence: 0, reason: `no usable noul answer for "${question.id}"`, value: false };
    return { confidence: Math.abs(2 * p - 1), value: p >= 0.5 };
  }
  if (question.mode === "choice") {
    const choice = answer.choice;
    if (typeof choice !== "string" || choice.length === 0) return { confidence: 0, reason: `no usable choice answer for "${question.id}"`, value: "" };
    const n = Object.keys(question.options).length;
    const probabilities = answer.probabilities ?? { [choice]: 1 };
    let pmax = 0;
    for (const value of Object.values(probabilities)) if (typeof value === "number" && value > pmax) pmax = value;
    const confidence = n <= 1 ? 1 : (pmax - 1 / n) / (1 - 1 / n);
    return { confidence: Math.max(0, Math.min(1, confidence)), value: choice };
  }
  const score = answer.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return { confidence: 0, reason: `no usable score answer for "${question.id}"`, value: 0 };
  return { confidence: typeof answer.confidence === "number" ? answer.confidence : 0, value: score };
}

/** §1-shaped decide runtime; offline only. */
export function createDecideRuntime(deps: DecideRuntimeDeps): DecideRuntime {
  const now = deps.now ?? (() => Date.now());
  const hash = deps.hash ?? ((input: string) => createHash("sha256").update(input).digest("hex"));

  const call = async (input: DecideCall): Promise<DecideVerdict | DecideVerdict[]> => {
    const questions = Array.isArray(input.questions) ? input.questions : [input.questions];
    const ids = questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate question ids in one decide call");

    const useCache = input.cache !== false;
    const cachedVerdicts = new Map<string, DecideVerdict>();
    const misses: DecideQuestion[] = [];
    for (const question of questions) {
      const key = `decide/cache/${hash(stableStringify({ state: input.state, question }))}`;
      const stored = useCache ? await deps.storage.get(key) : undefined;
      if (stored !== undefined && stored !== null && typeof stored === "object") {
        cachedVerdicts.set(question.id, { ...(stored as unknown as DecideVerdict), cached: true, latencyMs: 0 });
      } else {
        misses.push(question);
      }
    }

    const freshVerdicts = new Map<string, DecideVerdict>();
    let usage: { input_tokens: number | null; output_tokens: number | null } | undefined;
    const started = now();
    if (misses.length > 0) {
      const request: SystemOneRequest = {
        state: input.state as Json,
        questions: Object.fromEntries(misses.map((question) => [question.id, toSystemOneQuestion(question)])),
        ...(input.model === undefined ? {} : { model: input.model }),
      };
      const result = await deps.judge.systemOne(request, input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs });
      usage = result.usage;
      for (const question of misses) {
        const answer = result.answers[question.id];
        const { confidence, reason, value } = confidenceFor(question, answer);
        const threshold = question.escalateBelow ?? input.escalateBelow;
        const thresholdHit = typeof threshold === "number" && Number.isFinite(threshold) && confidence < threshold;
        const escalate = reason !== undefined || thresholdHit;
        const verdict: DecideVerdict = {
          id: question.id,
          mode: question.mode,
          value,
          ...(question.mode === "noul" && answer !== undefined && typeof answer.noul === "number" ? { p: answer.noul } : {}),
          ...(question.mode === "choice" && answer?.probabilities !== undefined ? { probabilities: answer.probabilities } : {}),
          confidence,
          modelId: result.model,
          latencyMs: Math.max(0, now() - started),
          cached: false,
          escalate,
          ...(escalate ? { reason: reason ?? `confidence ${confidence.toFixed(2)} below threshold ${String(threshold)}` } : {}),
        };
        freshVerdicts.set(question.id, verdict);
        if (useCache) {
          const { latencyMs: _latencyMs, cached: _cached, ...stored } = verdict;
          await deps.storage.set(
            `decide/cache/${hash(stableStringify({ state: input.state, question }))}`,
            stored as unknown as Json,
          );
        }
      }
    }

    const ordered = questions.map((question) => (cachedVerdicts.get(question.id) ?? freshVerdicts.get(question.id))!);
    const latencyMs = misses.length === 0 ? 0 : Math.max(0, now() - started);
    const entry: Json = {
      at: started,
      modelId: deps.judge.modelId,
      latencyMs,
      cached: misses.length === 0,
      questionIds: ids,
      verdicts: ordered.map((verdict) => ({
        id: verdict.id,
        mode: verdict.mode,
        value: verdict.value as Json,
        confidence: verdict.confidence,
        escalate: verdict.escalate,
      })),
      ...(usage === undefined ? {} : { usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } }),
    };
    try {
      await deps.log?.(entry);
    } catch {
      // Logging never throws into the caller path.
    }

    return Array.isArray(input.questions) ? ordered : ordered[0]!;
  };

  const tool: DecidePluginTool = {
    name: DECIDE_TOOL_NAME,
    description: "Ask a judgement question (noul/choice/score) about a self-contained state.",
    input: SHIM_DECIDE_INPUT_SCHEMA,
    output: SHIM_DECIDE_OUTPUT_SCHEMA,
    options: { namespace: DECIDE_NAMESPACE, codemode: true, pinned: true },
    async execute(input: unknown): Promise<{ output: DecideVerdict | DecideVerdict[]; content: string }> {
      if (typeof input !== "object" || input === null) throw new Error("decide expects an object input");
      const record = input as Record<string, unknown>;
      if (record.state === undefined) throw new Error("decide requires `state`");
      if (record.questions === undefined) throw new Error("decide requires `questions`");
      const output = await call(input as DecideCall);
      return { output, content: JSON.stringify(output) };
    },
  };

  return { call, tool };
}
