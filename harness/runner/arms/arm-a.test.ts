import { afterAll, describe, expect, test } from "bun:test";
import { runArmA } from "./arm-a.ts";
import type { ArmContext } from "./context.ts";
import { isTruncated, truncationNote } from "../../metrics/index.ts";
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

describe("arm A: direct tool loop", () => {
  test("stops after the first turn with no tool calls", async () => {
    const driver = replayDriver([response("all done", [])]);
    const result = await runArmA(context({ driver, toolbox: await testToolbox() }));

    expect(result.arm).toBe("A");
    expect(result.ok).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.transcript).toBe("all done");
    expect(result.toolCalls).toEqual([]);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]!.tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "glob",
      "shell",
      "edit",
      "write",
    ]);
  });

  test("executes tool calls in order, feeds results back and stops when the model stops calling tools", async () => {
    const toolbox = await testToolbox({ "a.txt": "hello" });
    const driver = replayDriver([
      response("reading", [
        { name: "read", input: { path: "a.txt" } },
        { name: "write", input: { path: "b.txt", content: "written" } },
      ]),
      response("done", []),
    ]);

    const result = await runArmA(context({ driver, toolbox }));

    expect(result.turns).toBe(2);
    expect(result.toolCalls).toEqual(["read", "write"]);
    expect(result.toolFailures).toBe(0);
    expect(result.transcript).toBe("done");

    // The second request sees the assistant turn plus one tool message per call.
    const second = driver.requests[1]!.messages;
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(second[3]!.toolName).toBe("read");
    expect(second[3]!.text).toContain("hello");
    expect(second[4]!.text).toContain("b.txt");
  });

  test("accumulates usage across turns and attributes cost when the model is priced", async () => {
    const driver = replayDriver([
      response("one", [{ name: "read", input: { path: "a.txt" } }], usage(1, 100, 2)),
      response("two", [], usage(3, 300, 4)),
    ]);
    const result = await runArmA(context({ driver, toolbox: await testToolbox({ "a.txt": "x" }), modelId: "unpriced-model" }));

    expect(result.usage).toEqual({ fresh: 4, cacheWrite: 0, cacheRead: 400, output: 6 });
    expect(result.usage.costUsd).toBeUndefined(); // unknown model ⇒ never guessed
  });

  test("stops at maxTurns and says so", async () => {
    const toolbox = await testToolbox({ "a.txt": "x" });
    const driver = replayDriver([
      response("again", [{ name: "read", input: { path: "a.txt" } }]),
      response("again", [{ name: "read", input: { path: "a.txt" } }]),
      response("again", [{ name: "read", input: { path: "a.txt" } }]),
    ]);
    const result = await runArmA(context({ driver, toolbox, maxTurns: 2 }));

    expect(result.turns).toBe(2);
    expect(driver.requests).toHaveLength(2);
    expect(result.toolCalls).toEqual(["read", "read"]);
    expect(result.notes).toContain(truncationNote(2));
    expect(isTruncated(result)).toBe(true);
  });

  test("counts tool failures, keeps looping and shows the failure to the model", async () => {
    const toolbox = await testToolbox();
    const driver = replayDriver([
      response("oops", [{ name: "read", input: { path: "../escape.txt" } }]),
      response("recovered", []),
    ]);
    const result = await runArmA(context({ driver, toolbox }));

    expect(result.turns).toBe(2);
    expect(result.toolFailures).toBe(1);
    expect(result.toolCalls).toEqual(["read"]);
    expect(result.notes.join(" ")).toContain("escapes the scratch directory");
    expect(driver.requests[1]!.messages.at(-1)!.text).toContain("failed");
  });

  test("a driver error is a harness-level error: ok stays false and verify still runs", async () => {
    const driver = replayDriver([]);
    const result = await runArmA(context({ driver, toolbox: await testToolbox(), task: testTask({ verifyPassed: true }) }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no more canned responses");
    expect(result.turns).toBe(0);
    expect(result.correctness.passed).toBe(true);
  });

  test("attaches the task's verify result, and a throwing verify is reported as a failure", async () => {
    const failing = await runArmA(
      context({
        driver: replayDriver([response("done", [])]),
        toolbox: await testToolbox(),
        task: testTask({ verifyPassed: false }),
      }),
    );
    expect(failing.correctness.passed).toBe(false);

    const throwing = await runArmA(
      context({
        driver: replayDriver([response("done", [])]),
        toolbox: await testToolbox(),
        task: testTask({
          verify: async () => {
            throw new Error("verify exploded");
          },
        }),
      }),
    );
    expect(throwing.correctness.passed).toBe(false);
    expect(throwing.correctness.detail).toContain("verify exploded");
  });
});
