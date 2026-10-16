import { describe, expect, test } from "bun:test";
import type { ArmID, ArmResult } from "../types.ts";
import { emptySummary, evaluateGate, summarise, summariseByArm } from "./index.ts";

/** Hand-built `ArmResult` fixture — no runner, no sandbox, pure metric math. */
function result(arm: ArmID, overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    arm,
    taskId: "t1",
    runIndex: 0,
    ok: true,
    turns: 1,
    usage: { fresh: 100, cacheWrite: 0, cacheRead: 1000, output: 50 },
    wallMs: 10,
    toolCalls: ["read"],
    toolFailures: 0,
    correctness: { passed: true },
    transcript: "",
    logs: [],
    decideCalls: [],
    decideLatencyMs: 0,
    escalated: false,
    escalations: 0,
    scriptFailures: 0,
    notes: [],
    ...overrides,
  };
}

describe("summarise", () => {
  test("empty input yields a zeroed summary", () => {
    expect(summarise([])).toEqual(emptySummary());
  });

  test("means, rates and optional cost are computed over the runs", () => {
    const summary = summarise([
      result("A", { turns: 2, wallMs: 20, toolCalls: ["a", "b"], usage: { fresh: 10, cacheWrite: 0, cacheRead: 100, output: 5, costUsd: 0.02 }, escalated: true, escalations: 1, scriptFailures: 1, correctness: { passed: false }, ok: false }),
      result("A", { turns: 4, wallMs: 40, usage: { fresh: 30, cacheWrite: 0, cacheRead: 300, output: 15, costUsd: 0.04 } }),
    ]);

    expect(summary.runs).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.correctnessPassed).toBe(1);
    expect(summary.turnsMean).toBe(3);
    expect(summary.wallMsMean).toBe(30);
    expect(summary.toolCallsMean).toBe(1.5);
    expect(summary.cacheReadTokensMean).toBe(200);
    expect(summary.freshTokensMean).toBe(20);
    expect(summary.outputTokensMean).toBe(10);
    expect(summary.costUsdMean).toBeCloseTo(0.03, 8);
    expect(summary.escalationRate).toBe(0.5);
    expect(summary.scriptFailureRate).toBe(0.5);
    expect(summary.decideCallsMean).toBe(0);
  });

  test("costUsdMean stays undefined when no run reports a cost", () => {
    const summary = summarise([result("A"), result("A")]);
    expect(summary.costUsdMean).toBeUndefined();
  });

  test("summariseByArm always exposes A, B and C", () => {
    const byArm = summariseByArm([result("B"), result("B"), result("C")]);
    expect(Object.keys(byArm)).toEqual(["A", "B", "C"]);
    expect(byArm.A.runs).toBe(0);
    expect(byArm.B.runs).toBe(2);
    expect(byArm.C.runs).toBe(1);
  });
});

describe("evaluateGate", () => {
  test("passes when C reads fewer cached tokens, is at least as correct and escalates rarely", () => {
    const gate = evaluateGate(
      summariseByArm([
        result("A", { usage: { fresh: 100, cacheWrite: 0, cacheRead: 5000, output: 10 } }),
        result("B", { usage: { fresh: 100, cacheWrite: 0, cacheRead: 2000, output: 10 } }),
        result("C", { usage: { fresh: 100, cacheWrite: 0, cacheRead: 1000, output: 10 }, decideCalls: [decideCall()], escalations: 0 }),
      ]),
    );
    expect(gate.cacheReadDownVsA).toBe(true);
    expect(gate.cacheReadDownVsB).toBe(true);
    expect(gate.correctnessEqualOrBetter).toBe(true);
    expect(gate.escalationLow).toBe(true);
    expect(gate.pass).toBe(true);
    expect(gate.notes.join(" ")).toContain("cache-read tokens/run");
  });

  test("fails on worse correctness even with fewer cache reads", () => {
    const gate = evaluateGate(
      summariseByArm([
        result("A", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 5000, output: 0 } }),
        result("B", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 4000, output: 0 } }),
        result("C", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 1, output: 0 }, correctness: { passed: false } }),
      ]),
    );
    expect(gate.cacheReadDownVsA).toBe(true);
    expect(gate.correctnessEqualOrBetter).toBe(false);
    expect(gate.pass).toBe(false);
  });

  test("fails when C escalates too often", () => {
    const gate = evaluateGate(
      summariseByArm([
        result("A", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 5000, output: 0 } }),
        result("B", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 4000, output: 0 } }),
        result("C", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 1, output: 0 }, escalated: true, escalations: 1 }),
      ]),
    );
    expect(gate.escalationLow).toBe(false);
    expect(gate.pass).toBe(false);
  });

  test("fails when C does not read fewer cache tokens than A", () => {
    const gate = evaluateGate(
      summariseByArm([
        result("A", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 1000, output: 0 } }),
        result("B", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 2000, output: 0 } }),
        result("C", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 1000, output: 0 } }),
      ]),
    );
    expect(gate.cacheReadDownVsA).toBe(false);
    expect(gate.cacheReadDownVsB).toBe(true);
    expect(gate.pass).toBe(false);
  });

  test("warns when every arm reports zero cache reads (synthetic mock usage)", () => {
    const gate = evaluateGate(
      summariseByArm([
        result("A", { usage: { fresh: 10, cacheWrite: 0, cacheRead: 0, output: 5 } }),
        result("B", { usage: { fresh: 10, cacheWrite: 0, cacheRead: 0, output: 5 } }),
        result("C", { usage: { fresh: 10, cacheWrite: 0, cacheRead: 0, output: 5 } }),
      ]),
    );
    expect(gate.notes.join(" ")).toContain("synthetic");
  });

  test("an empty arm C cannot pass", () => {
    const gate = evaluateGate({ A: emptySummary(), B: summarizeTwo(), C: emptySummary() });
    expect(gate.pass).toBe(false);
    expect(gate.notes.join(" ")).toContain("no runs");
  });
});

function summarizeTwo() {
  return summarise([result("B", { usage: { fresh: 0, cacheWrite: 0, cacheRead: 2000, output: 0 } })]);
}

function decideCall() {
  return {
    at: 1,
    modelId: "jev-1.13-free",
    latencyMs: 7,
    cached: false,
    questionIds: ["q1"],
    verdicts: [{ id: "q1", mode: "noul", value: true, confidence: 0.9, escalate: false }],
  };
}
