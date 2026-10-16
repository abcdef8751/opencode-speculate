/**
 * Metric aggregation: `ArmResult[]` → `ArmSummary`, and the plan's `GateVerdict`.
 *
 * OWNER: worker D1.
 */

import type { ArmID, ArmResult, ArmSummary, GateVerdict } from "../types.ts";

export const ARM_IDS: readonly ArmID[] = ["A", "B", "C"];

export function emptySummary(): ArmSummary {
  return {
    runs: 0,
    ok: 0,
    correctnessPassed: 0,
    turnsMean: 0,
    cacheReadTokensMean: 0,
    freshTokensMean: 0,
    outputTokensMean: 0,
    wallMsMean: 0,
    toolCallsMean: 0,
    escalationRate: 0,
    scriptFailureRate: 0,
    decideCallsMean: 0,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function meanDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) return undefined;
  return mean(defined);
}

/** Aggregates the runs of one arm into an `ArmSummary`. */
export function summarise(results: readonly ArmResult[]): ArmSummary {
  const summary = emptySummary();
  summary.runs = results.length;
  if (results.length === 0) return summary;

  summary.ok = results.filter((result) => result.ok).length;
  summary.correctnessPassed = results.filter((result) => result.correctness.passed).length;
  summary.turnsMean = mean(results.map((result) => result.turns));
  summary.cacheReadTokensMean = mean(results.map((result) => result.usage.cacheRead));
  summary.freshTokensMean = mean(results.map((result) => result.usage.fresh));
  summary.outputTokensMean = mean(results.map((result) => result.usage.output));
  const cost = meanDefined(results.map((result) => result.usage.costUsd));
  if (cost !== undefined) summary.costUsdMean = cost;
  summary.wallMsMean = mean(results.map((result) => result.wallMs));
  summary.toolCallsMean = mean(results.map((result) => result.toolCalls.length));
  summary.escalationRate = results.filter((result) => result.escalated).length / results.length;
  summary.scriptFailureRate = results.filter((result) => result.scriptFailures > 0).length / results.length;
  summary.decideCallsMean = mean(results.map((result) => result.decideCalls.length));
  return summary;
}

/** Groups results by arm; every arm key is present (zeroed when an arm produced no runs). */
export function summariseByArm(results: readonly ArmResult[]): Record<ArmID, ArmSummary> {
  const out: Record<ArmID, ArmSummary> = {
    A: emptySummary(),
    B: emptySummary(),
    C: emptySummary(),
  };
  for (const arm of ARM_IDS) {
    out[arm] = summarise(results.filter((result) => result.arm === arm));
  }
  return out;
}

export interface GateOptions {
  /** Maximum tolerated escalation rate in arm C. Default 0.25. */
  maxEscalationRate?: number;
}

/**
 * Evaluates the plan's gate:
 *   - cache-read tokens down in C vs A (the hypothesis);
 *   - correctness equal-or-better in C vs every other arm;
 *   - escalation rate in C low.
 *
 * `cacheReadDownVsB` is reported as well (it says whether the *decide* lever on top of the script
 * costs cache reads), but it is not part of `pass` — the gate names the A baseline.
 */
export function evaluateGate(summary: Record<ArmID, ArmSummary>, opts: GateOptions = {}): GateVerdict {
  const maxEscalationRate = opts.maxEscalationRate ?? 0.25;
  const a = summary.A;
  const b = summary.B;
  const c = summary.C;
  const notes: string[] = [];

  const cacheReadDownVsA = c.cacheReadTokensMean < a.cacheReadTokensMean;
  const cacheReadDownVsB = c.cacheReadTokensMean < b.cacheReadTokensMean;

  const passRate = (s: ArmSummary): number => (s.runs === 0 ? 0 : s.correctnessPassed / s.runs);
  const cRate = passRate(c);
  const aRate = passRate(a);
  const bRate = passRate(b);
  const correctnessEqualOrBetter = cRate >= aRate && cRate >= bRate;

  const escalationLow = c.escalationRate <= maxEscalationRate;

  notes.push(
    `cache-read tokens/run: A=${a.cacheReadTokensMean.toFixed(1)} B=${b.cacheReadTokensMean.toFixed(1)} C=${c.cacheReadTokensMean.toFixed(1)}`,
  );
  if (c.runs === 0) notes.push("arm C produced no runs — gate cannot be satisfied");
  notes.push(`correctness pass rate: A=${aRate.toFixed(2)} B=${bRate.toFixed(2)} C=${cRate.toFixed(2)}`);
  notes.push(`escalation rate (C)=${c.escalationRate.toFixed(2)} (max ${maxEscalationRate})`);
  if (cacheReadDownVsB) {
    notes.push("decide on top of the script also lowered cache reads vs arm B");
  } else if (b.cacheReadTokensMean > 0 || c.cacheReadTokensMean > 0) {
    notes.push("decide did not lower cache reads vs the script-only arm B (informational, not gating)");
  }
  if (a.runs > 0 && a.cacheReadTokensMean === 0 && c.cacheReadTokensMean === 0) {
    notes.push("both A and C report zero cache reads — with `--driver mock` these are synthetic numbers");
  }

  const pass = cacheReadDownVsA && correctnessEqualOrBetter && escalationLow && c.runs > 0;
  return { cacheReadDownVsA, cacheReadDownVsB, correctnessEqualOrBetter, escalationLow, pass, notes };
}
