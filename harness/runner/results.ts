/**
 * `ArmResult` construction helpers shared by the three arms.
 *
 * OWNER: worker D1.
 */

import { estimateCostUsd, zeroUsage } from "../pricing.ts";
import type { Json } from "../types.ts";
import type { ArmID, ArmResult, DecideCallRecord, TokenUsage } from "../types.ts";
import type { DecideLogEntry } from "../sandbox/decide-port.ts";

export const DEFAULT_MAX_TURNS = 12;

export { zeroUsage };

/** A fresh, empty `ArmResult` for one (arm, task, run). */
export function emptyResult(arm: ArmID, taskId: string, runIndex: number): ArmResult {
  return {
    arm,
    taskId,
    runIndex,
    ok: false,
    turns: 0,
    usage: zeroUsage(),
    wallMs: 0,
    toolCalls: [],
    toolFailures: 0,
    correctness: { passed: false, detail: "not verified" },
    transcript: "",
    logs: [],
    decideCalls: [],
    decideLatencyMs: 0,
    escalated: false,
    escalations: 0,
    scriptFailures: 0,
    notes: [],
  };
}

/** Fills `costUsd` from the pricing table when the driver did not report one. */
export function attributeCost(usage: TokenUsage, modelId: string | undefined): TokenUsage {
  if (usage.costUsd !== undefined) return usage;
  const cost = estimateCostUsd(usage, modelId);
  if (cost === undefined) return usage;
  return { ...usage, costUsd: cost };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort mapping of one §1 decision-log entry onto `DecideCallRecord`. */
export function toDecideCallRecord(entry: Json): DecideCallRecord | undefined {
  if (!isRecord(entry)) return undefined;
  const { at, modelId, latencyMs, cached, questionIds, verdicts } = entry;
  if (typeof at !== "number" || typeof modelId !== "string" || typeof latencyMs !== "number") return undefined;
  if (typeof cached !== "boolean" || !Array.isArray(questionIds) || !Array.isArray(verdicts)) return undefined;
  const mapped = [];
  for (const verdict of verdicts) {
    if (!isRecord(verdict)) return undefined;
    const { id, mode, value, confidence, escalate } = verdict;
    if (typeof id !== "string" || typeof mode !== "string" || typeof confidence !== "number") return undefined;
    if (typeof escalate !== "boolean" || (value !== null && typeof value !== "object" && typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean")) {
      return undefined;
    }
    mapped.push({ id, mode, value: value as Json, confidence, escalate });
  }
  return {
    at,
    modelId,
    latencyMs,
    cached,
    questionIds: questionIds.map(String),
    verdicts: mapped,
  };
}

export interface DecideLogState {
  decideCalls: DecideCallRecord[];
  escalations: number;
  notes: string[];
}

/** Builds the `log` sink that turns §1 decision-log entries into `ArmResult` fields. */
export function decideLogSink(state: DecideLogState): (entry: Json) => void {
  return (entry: Json) => {
    const record = toDecideCallRecord(entry);
    if (record === undefined) {
      state.notes.push(`unrecognised decide log entry: ${JSON.stringify(entry).slice(0, 200)}`);
      return;
    }
    state.decideCalls.push(record);
    state.escalations += record.verdicts.filter((verdict) => verdict.escalate).length;
  };
}

/** Applies the decision-log state onto an `ArmResult`. */
export function applyDecideState(result: ArmResult, state: DecideLogState): void {
  result.decideCalls = state.decideCalls;
  result.escalations = state.escalations;
  result.escalated = state.escalations > 0;
  result.decideLatencyMs = state.decideCalls.reduce((total, call) => total + call.latencyMs, 0);
  result.notes.push(...state.notes);
}

/** Convenience re-export so arms can type the sink without importing the port module. */
export type { DecideLogEntry };
