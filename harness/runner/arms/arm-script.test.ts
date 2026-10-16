import { afterAll, describe, expect, test } from "bun:test";
import { runArmB, runArmC, extractScript, scriptPrompt } from "./arm-script.ts";
import { EXECUTE_TOOL, type ArmContext } from "./context.ts";
import type { DecidePluginTool, DecideRuntime, DecideRuntimeDeps } from "../../sandbox/decide-port.ts";
import { createFakeJudge } from "../../drivers/index.ts";
import { createDecideRuntime } from "../../../src/decide/index.ts";
import { cleanupTempDirs, replayDriver, response, testTask, testToolbox, usage } from "../testing.ts";

afterAll(cleanupTempDirs);

function context(overrides: Partial<ArmContext>): ArmContext {
  return {
    driver: replayDriver([]),
    toolbox: { dir: "/tmp/opencode", descriptors: [], names: [], call: async () => null },
    task: testTask(),
    runIndex: 0,
    maxTurns: 5,
    ...overrides,
  };
}

/** A decide runtime that answers with a low-confidence, escalating verdict and logs it. */
function stubDecideFactory(seen: { deps?: DecideRuntimeDeps } = {}): (deps: DecideRuntimeDeps) => DecideRuntime {
  return (deps) => {
    seen.deps = deps;
    const tool: DecidePluginTool = {
      name: "decide",
      description: "stub decide",
      input: { type: "object" },
      output: { type: "object" },
      options: { namespace: "typesafe", codemode: true, pinned: true },
      async execute(input) {
        const questions = (input as { questions?: unknown }).questions;
        const id = String(Array.isArray(questions) ? (questions[0] as { id?: unknown })?.id : (questions as { id?: unknown })?.id);
        const verdict = {
          id,
          mode: "noul" as const,
          value: true,
          confidence: 0.2,
          modelId: "stub-judge",
          latencyMs: 7,
          cached: false,
          escalate: true,
          reason: "confidence 0.20 below threshold 0.5",
        };
        await deps.log?.({
          at: 1234,
          modelId: "stub-judge",
          latencyMs: 7,
          cached: false,
          questionIds: [id],
          verdicts: [verdict],
        } as never);
        return { output: verdict, content: JSON.stringify(verdict) };
      },
    };
    return { call: async () => [], tool };
  };
}

describe("script extraction", () => {
  test("prefers an `execute` tool call, then fenced code, then raw text", () => {
    expect(extractScript("ignored", [{ name: "execute", input: { code: "return 1;" } }])).toBe("return 1;");
    expect(extractScript("here:\n```js\nreturn 2;\n```\nthanks", [])).toBe("return 2;");
    expect(extractScript("  return 3;  ", [])).toBe("return 3;");
    expect(extractScript("   ", [])).toBeUndefined();
    expect(extractScript("text", [{ name: "execute", input: {} }])).toBe("text");
  });

  test("the arm C prompt adds the task's escalation prompt and names the decide path", () => {
    const task = testTask({ escalationPrompt: "ESCALATE-ON-LOW-CONFIDENCE" });
    const b = scriptPrompt("B", context({ task }));
    const c = scriptPrompt("C", context({ task }));
    expect(b).toBe("write one script that does the thing");
    expect(c).toContain("ESCALATE-ON-LOW-CONFIDENCE");
    expect(c).toContain("tools.typesafe.decide");
  });
});

describe("arm B: script, no decide", () => {
  test("one model call, program executed over the toolbox, transcript is the script", async () => {
    const toolbox = await testToolbox({ "a.txt": "payload" });
    const driver = replayDriver([
      response('Here you go:\n```js\nconst text = await tools.read({ path: "a.txt" });\nconsole.log("got", text);\nreturn text.length;\n```'),
    ]);
    const result = await runArmB(context({ driver, toolbox }));

    expect(result.arm).toBe("B");
    expect(result.ok).toBe(true);
    expect(result.turns).toBe(1);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]!.tools.map((tool) => tool.name)).toEqual([EXECUTE_TOOL.name]);
    expect(result.transcript).toBe('const text = await tools.read({ path: "a.txt" });\nconsole.log("got", text);\nreturn text.length;');
    expect(result.logs).toEqual(["got payload"]);
    expect(result.toolCalls).toEqual(["read"]);
    expect(result.scriptFailures).toBe(0);
    expect(result.decideCalls).toEqual([]);
    expect(result.correctness.passed).toBe(true);
  });

  test("accepts the program as an `execute` tool call", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([response("", [{ name: "execute", input: { code: "return 40 + 2;" } }])]);
    const result = await runArmB(context({ driver, toolbox }));
    expect(result.ok).toBe(true);
    expect(result.transcript).toBe("return 40 + 2;");
    expect(result.notes.join(" ")).toContain("returned: 42");
  });

  test("a parse failure is a script failure, not a harness error", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([response("this is not js")]);
    const result = await runArmB(context({ driver, toolbox }));

    expect(result.ok).toBe(false);
    expect(result.scriptFailures).toBe(1);
    expect(result.notes.join(" ")).toContain("ParseError");
    expect(result.error).toBeUndefined();
    expect(result.toolFailures).toBe(0);
  });

  test("a failed tool call inside the script counts as a tool failure", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([response('const x = await tools.read({ path: "missing.txt" }); return x;')]);
    const result = await runArmB(context({ driver, toolbox }));

    expect(result.toolFailures).toBe(1);
    expect(result.toolCalls).toEqual(["read"]);
    expect(result.scriptFailures).toBe(1);
  });

  test("a driver that returns no program is a script failure with the raw text kept", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([response("   ")]);
    const result = await runArmB(context({ driver, toolbox }));

    expect(result.scriptFailures).toBe(1);
    expect(result.notes.join(" ")).toContain("no Code Mode program");
    expect(result.transcript).toBe("   ");
  });
});

describe("arm C: script + decide", () => {
  test("registers the decide tool through the injected factory, maps the log sink and counts escalations", async () => {
    const toolbox = await testToolbox();
    const seen: { deps?: DecideRuntimeDeps } = {};
    const driver = replayDriver([
      response(
        [
          "const d = await tools.typesafe.decide({ state: { n: 1 }, questions: { mode: \"noul\", id: \"q1\", criteria: { true: \"a\", false: \"b\" } } });",
          'if (d.escalate) { console.log("escalated:", d.reason); }',
          "return { escalate: d.escalate, confidence: d.confidence };",
        ].join("\n"),
      ),
    ]);

    const result = await runArmC(
      context({
        driver,
        toolbox,
        task: testTask({ escalationPrompt: "use decide" }),
        createDecideRuntime: stubDecideFactory(seen),
        judge: createFakeJudge({}),
        maxTurns: 1,
      }),
    );

    expect(result.arm).toBe("C");
    expect(result.ok).toBe(true);
    expect(result.turns).toBe(1);
    expect(seen.deps?.judge).toBeDefined();
    expect(typeof seen.deps?.storage.get).toBe("function");
    expect(result.toolCalls).toEqual(["typesafe.decide"]);
    expect(result.decideCalls).toHaveLength(1);
    expect(result.decideCalls[0]!.questionIds).toEqual(["q1"]);
    expect(result.decideLatencyMs).toBe(7);
    expect(result.escalations).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.logs.join(" ")).toContain("escalated: confidence 0.20 below threshold 0.5");
  });

  test("arm C without a decide runtime fails loudly", async () => {
    const driver = replayDriver([response("return 1;")]);
    const result = await runArmC(context({ driver, toolbox: await testToolbox() }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("arm C requires");
  });

  test("the real decide runtime + fake judge produce decide records and non-escalating verdicts", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([
      response(
        [
          "const d = await tools.typesafe.decide({ state: { a: 1 }, questions: { mode: \"noul\", id: \"q1\", criteria: { true: \"yes\", false: \"no\" } }, escalateBelow: 0.5 });",
          "if (d.escalate) { console.log(\"escalate\"); return { escalated: true }; }",
          "return { value: d.value, confidence: d.confidence };",
        ].join("\n"),
      ),
    ]);
    const result = await runArmC(
      context({
        driver,
        toolbox,
        createDecideRuntime,
        judge: createFakeJudge({ q1: { noul: 0.95, confidence: 0.9 } }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.decideCalls).toHaveLength(1);
    const verdict = result.decideCalls[0]!.verdicts[0]!;
    expect(verdict.id).toBe("q1");
    expect(verdict.mode).toBe("noul");
    expect(verdict.value).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.9, 8);
    expect(verdict.escalate).toBe(false);
    expect(result.escalated).toBe(false);
    expect(result.escalations).toBe(0);
    expect(result.decideLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("the real runtime escalates on a low-confidence answer, and counts it", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([
      response(
        [
          "const d = await tools.typesafe.decide({ state: { a: 1 }, questions: { mode: \"noul\", id: \"q1\", criteria: { true: \"yes\", false: \"no\" } }, escalateBelow: 0.9 });",
          'if (d.escalate) { console.log("escalated:", d.reason); return { escalated: true }; }',
          "return { escalated: false };",
        ].join("\n"),
      ),
    ]);
    const result = await runArmC(
      context({
        driver,
        toolbox,
        createDecideRuntime,
        judge: createFakeJudge({ q1: { noul: 0.6, confidence: 0.2 } }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.escalations).toBe(1);
    expect(result.logs.join(" ")).toContain("escalated:");
    expect(result.decideCalls[0]!.verdicts[0]!.escalate).toBe(true);
  });

  test("a decide question the judge cannot answer fails the script (fail loud, counted)", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([
      response(
        "const d = await tools.typesafe.decide({ state: { a: 1 }, questions: { mode: \"noul\", id: \"unscripted\", criteria: { true: \"y\", false: \"n\" } } }); return d.value;",
      ),
    ]);
    const result = await runArmC(
      context({ driver, toolbox, createDecideRuntime, judge: createFakeJudge({ other: { noul: 0.9 } }) }),
    );

    expect(result.ok).toBe(false);
    expect(result.scriptFailures).toBe(1);
    expect(result.decideCalls).toEqual([]);
    expect(result.toolFailures).toBe(1);
    expect(result.notes.join(" ")).toContain("no scripted answer");
  });

  test("usage from the single turn is attributed, and tools list is the execute tool", async () => {
    const driver = replayDriver([response("return 1;", [], usage(7, 70, 3))]);
    const result = await runArmC(
      context({
        driver,
        toolbox: await testToolbox(),
        createDecideRuntime: stubDecideFactory(),
        judge: createFakeJudge({}),
        modelId: "jev-1.13-free",
      }),
    );
    expect(result.usage.fresh).toBe(7);
    expect(result.usage.cacheRead).toBe(70);
    expect(result.usage.costUsd).toBe(0); // known free model
    expect(driver.requests[0]!.tools.map((tool) => tool.name)).toEqual(["execute"]);
  });
});
