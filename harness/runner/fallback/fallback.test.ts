import { describe, expect, test } from "bun:test";
import { createFakeJudge, createMockDriver, parseOpenCodeJsonOutput } from "./drivers.ts";
import { createDecideRuntime } from "./decide-shim.ts";
import { FALLBACK_JUDGE_ANSWERS } from "./scenario.ts";
import { armSystemMessage, parseArmMarker } from "../arms/context.ts";
import { createMemoryStorage } from "../storage.ts";
import { testTask } from "../testing.ts";
import type { Json } from "../../types.ts";
import type { DecideCall } from "../../sandbox/decide-port.ts";

describe("arm marker", () => {
  test("round-trips through the system message for every arm", () => {
    const task = testTask({ id: "demo" });
    for (const arm of ["A", "B", "C"] as const) {
      const marker = parseArmMarker(armSystemMessage(arm, task, 4));
      expect(marker).toEqual({ arm, taskId: "demo", runIndex: 4 });
    }
    expect(parseArmMarker("no marker here")).toBeUndefined();
    expect(parseArmMarker(undefined)).toBeUndefined();
  });
});

describe("fallback mock driver", () => {
  test("replays arm A's plan one call per turn, then stops", async () => {
    const driver = createMockDriver();
    const task = testTask({ id: "fallback-fix-typo" });
    const messages = [
      { role: "system" as const, text: armSystemMessage("A", task, 0) },
      { role: "user" as const, text: "go" },
    ];

    const first = await driver.complete({ messages, tools: [] });
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]!.name).toBe("read");
    expect(first.usage.cacheRead).toBe(900);

    const second = await driver.complete({
      messages: [...messages, { role: "assistant" as const, text: "step 1", toolCalls: first.toolCalls }, { role: "tool" as const, text: "ok" }],
      tools: [],
    });
    expect(second.toolCalls[0]!.name).toBe("edit");

    const third = await driver.complete({
      messages: [
        ...messages,
        { role: "assistant" as const, text: "a", toolCalls: first.toolCalls },
        { role: "tool" as const, text: "ok" },
        { role: "assistant" as const, text: "b", toolCalls: second.toolCalls },
        { role: "tool" as const, text: "ok" },
      ],
      tools: [],
    });
    expect(third.toolCalls).toEqual([]);
    expect(third.text).toContain("Fixed the greeting typo");
  });

  test("returns the canned program for B and C, and honours an override", async () => {
    const driver = createMockDriver();
    const task = testTask({ id: "fallback-fix-typo" });
    const b = await driver.complete({ messages: [{ role: "system", text: armSystemMessage("B", task, 0) }], tools: [] });
    const c = await driver.complete({ messages: [{ role: "system", text: armSystemMessage("C", task, 0) }], tools: [] });
    expect(b.text).toContain("tools.read");
    expect(b.text).not.toContain("typesafe.decide");
    expect(c.text).toContain("tools.typesafe.decide");

    const overridden = createMockDriver({ programs: { "fallback-fix-typo": { B: "return 'override';" } } });
    const over = await overridden.complete({ messages: [{ role: "system", text: armSystemMessage("B", task, 0) }], tools: [] });
    expect(over.text).toBe("return 'override';");
  });

  test("is deterministic for a given seed, and fails loudly without a marker or scenario", async () => {
    const task = testTask({ id: "fallback-count-todos" });
    const messages = [{ role: "system" as const, text: armSystemMessage("B", task, 0) }];
    const a = await createMockDriver({ seed: 5 }).complete({ messages, tools: [] });
    const b = await createMockDriver({ seed: 5 }).complete({ messages, tools: [] });
    expect(a).toEqual(b);

    await expect(createMockDriver().complete({ messages: [{ role: "user", text: "no marker" }], tools: [] })).rejects.toThrow(/marker/);
    await expect(
      createMockDriver().complete({ messages: [{ role: "system", text: "harness:arm=B;task=nope;run=0" }], tools: [] }),
    ).rejects.toThrow(/no fallback scenario/);
  });
});

describe("fallback fake judge", () => {
  test("answers by question id, records calls, and leaves unknown ids unusable", async () => {
    const judge = createFakeJudge({ q1: { noul: 0.8, confidence: 0.6 } });
    const result = await judge.systemOne({ state: { a: 1 }, questions: { q1: { type: "noul" }, q2: { type: "noul" } } });
    expect(judge.calls).toHaveLength(1);
    expect(result.answers.q1).toEqual({ type: "noul", noul: 0.8, confidence: 0.6 });
    expect(result.answers.q2).toEqual({ type: "noul" });
    expect(judge.modelId).toBe("fake-jev-v1");
  });
});

describe("fallback decide shim", () => {
  function runtime(answers = FALLBACK_JUDGE_ANSWERS) {
    const log: Json[] = [];
    const judge = createFakeJudge(answers);
    const storage = createMemoryStorage();
    return { log, judge, storage, rt: createDecideRuntime({ judge, storage, log: (entry) => void log.push(entry) }) };
  }

  test("single question returns one verdict; batch returns an array in order", async () => {
    const { rt } = runtime({ a: { noul: 0.9, confidence: 0.8 }, b: { choice: "yes", confidence: 0.7 } });
    const single = await rt.call({ state: "s", questions: { mode: "noul", id: "a", criteria: { true: "y", false: "n" } } });
    expect(Array.isArray(single)).toBe(false);

    const batch = await rt.call({
      state: "s",
      questions: [
        { mode: "noul", id: "a", criteria: { true: "y", false: "n" } },
        { mode: "choice", id: "b", options: { yes: null, no: null } },
      ],
    });
    expect(Array.isArray(batch)).toBe(true);
    expect((batch as { id: string }[]).map((verdict) => verdict.id)).toEqual(["a", "b"]);
  });

  test("escalates on a low-confidence verdict and on a missing answer, with a reason", async () => {
    const { rt } = runtime({ low: { noul: 0.51, confidence: 0.02 } });
    const verdict = await rt.call({
      state: "s",
      questions: { mode: "noul", id: "low", criteria: { true: "y", false: "n" } },
      escalateBelow: 0.5,
    });
    expect((verdict as { escalate: boolean }).escalate).toBe(true);
    expect((verdict as { reason?: string }).reason).toContain("below threshold");

    const missing = await rt.call({ state: "s", questions: { mode: "noul", id: "absent", criteria: { true: "y", false: "n" } }, escalateBelow: 0.5 });
    expect((missing as { escalate: boolean }).escalate).toBe(true);
    expect((missing as { reason?: string }).reason).toContain("absent");
  });

  test("without a threshold, a low-confidence verdict never escalates", async () => {
    const { rt } = runtime({ low: { noul: 0.51 } });
    const verdict = await rt.call({ state: "s", questions: { mode: "noul", id: "low", criteria: { true: "y", false: "n" } } });
    expect((verdict as { escalate: boolean }).escalate).toBe(false);
  });

  test("caches a verdict and logs one entry per judge request", async () => {
    const { rt, judge, log } = runtime({ a: { noul: 0.9, confidence: 0.8 } });
    const call: DecideCall = { state: "s", questions: { mode: "noul", id: "a", criteria: { true: "y", false: "n" } } };
    const first = (await rt.call(call)) as { cached: boolean; latencyMs: number };
    const second = (await rt.call(call)) as { cached: boolean; latencyMs: number };

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.latencyMs).toBe(0);
    expect(judge.calls).toHaveLength(1);
    expect(log).toHaveLength(2);

    const cacheOff = await rt.call({ ...call, cache: false });
    expect((cacheOff as { cached: boolean }).cached).toBe(false);
    expect(judge.calls).toHaveLength(2);
  });

  test("rejects duplicate ids and exposes the plugin tool at typesafe.decide", async () => {
    const { rt } = runtime();
    await expect(
      rt.call({
        state: "s",
        questions: [
          { mode: "noul", id: "dup", criteria: { true: "y", false: "n" } },
          { mode: "noul", id: "dup", criteria: { true: "y", false: "n" } },
        ],
      }),
    ).rejects.toThrow(/duplicate question ids/);

    expect(rt.tool.name).toBe("decide");
    expect(rt.tool.options).toEqual({ namespace: "typesafe", codemode: true, pinned: true });
    const output = await rt.tool.execute({ state: "s", questions: { mode: "noul", id: "q", criteria: { true: "y", false: "n" } } });
    expect((output.output as { id: string }).id).toBe("q");
    await expect(rt.tool.execute({ questions: [] })).rejects.toThrow(/requires `state`/);
  });
});

describe("opencode CLI output parsing", () => {
  test("sums nothing but reads the last usage object, text and tool calls", () => {
    const stdout = [
      JSON.stringify({ type: "text", text: "partial" }),
      JSON.stringify({ type: "tool_use", name: "read", input: { path: "a" } }),
      JSON.stringify({ type: "text", text: "final answer" }),
      JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 } }),
    ].join("\n");

    const parsed = parseOpenCodeJsonOutput(stdout);
    expect(parsed.text).toBe("final answer");
    expect(parsed.toolCalls).toEqual([{ name: "read", input: { path: "a" } }]);
    expect(parsed.usage).toEqual({ fresh: 500, cacheWrite: 100, cacheRead: 400, output: 50 });
    expect(parsed.notes).toEqual([]);
  });

  test("missing usage reports zeros and a note instead of throwing", () => {
    const parsed = parseOpenCodeJsonOutput("not json at all");
    expect(parsed.usage).toEqual({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(parsed.notes.join(" ")).toContain("no token usage found");
  });
});
