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
  /**
   * Driver provenance from the run (`RunReport.driver`). When it names the mock driver the verdict
   * carries a "SYNTHETIC NUMBERS" note, so the caveat travels with the number people quote.
   */
  driver?: string | undefined;
  /**
   * The run's per-run results (`RunReport.results`). Needed to detect a run that stopped at its turn
   * budget: `ok` cannot express truncation, so a truncated baseline would otherwise look healthy.
   */
  results?: readonly ArmResult[] | undefined;
}

/**
 * Stable `ArmResult.notes` marker for "this run's loop stopped at its turn budget". `ArmResult` is
 * frozen, so truncation is recorded in `notes` (emitted by `runner/arms/arm-a.ts`) and read back
 * here instead of adding a field.
 */
export const TRUNCATION_NOTE_PREFIX = "truncated at maxTurns=";

/** The note arm A records when it stops at its turn budget rather than finishing on its own. */
export function truncationNote(maxTurns: number): string {
  return `${TRUNCATION_NOTE_PREFIX}${maxTurns}`;
}

/** True when a run was cut off by its turn budget. */
export function isTruncated(result: Pick<ArmResult, "notes">): boolean {
  return result.notes.some((note) => note.startsWith(TRUNCATION_NOTE_PREFIX));
}

/** Truncated runs per arm. */
export function truncatedRunsByArm(results: readonly ArmResult[]): Record<ArmID, number> {
  const counts: Record<ArmID, number> = { A: 0, B: 0, C: 0 };
  for (const result of results) {
    if (isTruncated(result)) counts[result.arm] += 1;
  }
  return counts;
}

/**
 * True when the driver's token accounting is canned rather than measured. Lives here (not in
 * `../report.ts`) so the gate can flag synthetic runs without a module cycle; `report.ts` re-exports
 * it as `isMockDriver` for the CLI and the report banner.
 */
export function isMockDriver(driver: string | undefined): boolean {
  return driver !== undefined && driver.toLowerCase().includes("mock");
}

/**
 * Evaluates the plan's gate:
 *   - cache-read tokens down in C vs A (the hypothesis);
 *   - correctness equal-or-better in C vs every other arm;
 *   - escalation rate in C low;
 *   - **the baseline must be trustworthy**: arm A runs cannot have harness-level errors *and* none
 *     of them may have stopped at its turn budget, and arm C must have produced at least one
 *     successful run.
 *
 * The health rule exists because `correctnessEqualOrBetter` compares *rates*: a broken arm A
 * (correctness 0, or aborted mid-loop so its cache reads are undercounted) trivially satisfies
 * `cRate >= aRate` and could let C post a lower mean. `pass` therefore requires `A.ok === A.runs`
 * **and no truncated A run** (pass `results` so this can be seen — `ok` is a harness-error flag and
 * is `true` for a run that merely ran out of turns), plus `C.ok > 0`. Any arm with harness-level
 * errors or truncation is called out in `notes`.
 *
 * `cacheReadDownVsB` is reported as well (it says whether the *decide* lever on top of the script
 * costs cache reads), but it is not part of `pass` — the gate names the A baseline.
 *
 * Pass `driver` (e.g. `RunReport.driver`) so a synthetic mock run carries its caveat *inside* the
 * verdict: the value people quote must not be quotable without it.
 */
export function evaluateGate(summary: Record<ArmID, ArmSummary>, opts: GateOptions = {}): GateVerdict {
  const maxEscalationRate = opts.maxEscalationRate ?? 0.25;
  const a = summary.A;
  const b = summary.B;
  const c = summary.C;
  const notes: string[] = [];
  const synthetic = isMockDriver(opts.driver);

  if (synthetic) {
    notes.push(
      `SYNTHETIC NUMBERS (driver "${opts.driver}"): token counts are canned, not measured — this verdict is plumbing evidence, not a result`,
    );
  }

  const cacheReadDownVsA = c.cacheReadTokensMean < a.cacheReadTokensMean;
  const cacheReadDownVsB = c.cacheReadTokensMean < b.cacheReadTokensMean;

  const passRate = (s: ArmSummary): number => (s.runs === 0 ? 0 : s.correctnessPassed / s.runs);
  const cRate = passRate(c);
  const aRate = passRate(a);
  const bRate = passRate(b);
  const correctnessEqualOrBetter = cRate >= aRate && cRate >= bRate;

  const escalationLow = c.escalationRate <= maxEscalationRate;

  // Health: the baseline mean is only a baseline when every A run finished; C needs evidence.
  const truncated = opts.results === undefined ? { A: 0, B: 0, C: 0 } : truncatedRunsByArm(opts.results);
  const baselineTruncated = truncated.A > 0;
  const baselineHealthy = a.runs > 0 && a.ok === a.runs && !baselineTruncated;
  const challengerHasEvidence = c.ok > 0;
  const errors = ([
    ["A", a],
    ["B", b],
    ["C", c],
  ] as const)
    .filter(([, s]) => s.runs > 0 && s.ok < s.runs)
    .map(([arm, s]) => `${arm}=${s.ok}/${s.runs}`);

  notes.push(
    `cache-read tokens/run: A=${a.cacheReadTokensMean.toFixed(1)} B=${b.cacheReadTokensMean.toFixed(1)} C=${c.cacheReadTokensMean.toFixed(1)}`,
  );
  if (c.runs === 0) notes.push("arm C produced no runs — gate cannot be satisfied");
  for (const arm of ARM_IDS) {
    if (truncated[arm] > 0) {
      notes.push(
        `arm ${arm} was CUT OFF mid-task in ${truncated[arm]} run(s) (turn budget reached): its mean is a lower bound, not a completed measurement`,
      );
    }
  }
  if (baselineTruncated) {
    notes.push(
      `baseline arm A is not a valid baseline — see the truncation note above; gate cannot pass (raise \`--max-turns\` and re-run)`,
    );
  } else if (a.runs === 0) {
    notes.push("baseline arm A produced no runs — its cache-read mean cannot be a baseline");
  } else if (!baselineHealthy) {
    notes.push(`baseline arm A is not healthy (ok=${a.ok}/${a.runs}); its cache-read mean is not a trustworthy baseline — gate cannot pass`);
  }
  if (errors.length > 0) {
    notes.push(`harness-level errors (ok/runs): ${errors.join(" ")} — means include failed runs`);
  }
  if (!challengerHasEvidence) {
    notes.push("arm C has no successful run — there is no evidence for a win");
  }
  notes.push(`correctness pass rate: A=${aRate.toFixed(2)} B=${bRate.toFixed(2)} C=${cRate.toFixed(2)}`);
  notes.push(`escalation rate (C)=${c.escalationRate.toFixed(2)} (max ${maxEscalationRate})`);
  if (cacheReadDownVsB) {
    notes.push("decide on top of the script also lowered cache reads vs arm B");
  } else if (b.cacheReadTokensMean > 0 || c.cacheReadTokensMean > 0) {
    notes.push("decide did not lower cache reads vs the script-only arm B (informational, not gating)");
  }
  if (a.runs > 0 && a.cacheReadTokensMean === 0 && c.cacheReadTokensMean === 0) {
    notes.push(
      synthetic
        ? "both A and C report zero cache reads — these are synthetic numbers, not a measurement"
        : `both A and C report zero cache reads — the driver ("${opts.driver ?? "unset"}") reported no cache-read tokens, so the cache-read comparison carries no information`,
    );
  }

  const pass =
    cacheReadDownVsA && correctnessEqualOrBetter && escalationLow && c.runs > 0 && baselineHealthy && challengerHasEvidence;
  return { cacheReadDownVsA, cacheReadDownVsB, correctnessEqualOrBetter, escalationLow, pass, notes };
}
