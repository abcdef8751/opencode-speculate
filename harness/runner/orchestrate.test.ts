import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runHarness } from "./orchestrate.ts";
import { loadSources, describeOrigins, type Sources } from "./sources.ts";
import { createFakeJudge, createMockDriver, createOpenCodeCliDriver } from "./fallback/drivers.ts";
import { createDecideRuntime } from "./fallback/decide-shim.ts";
import { cleanupTempDirs, replayDriver, response, tempDir, testTask, writeFiles } from "./testing.ts";
import type { TaskDef } from "../types.ts";

afterAll(cleanupTempDirs);

const sources = await loadSources();

describe("module sources", () => {
  test("fall back to the D1 shim when the frozen modules are absent, and say so", () => {
    expect(sources.tasks.length).toBeGreaterThan(0);
    expect(sources.origin.tasks).toBe("fallback");
    expect(sources.origin.drivers).toBe("fallback");
    expect(sources.origin.decide).toBe("fallback");
    expect(sources.warnings.join(" ")).toContain("harness/tasks/index.ts missing");
    expect(describeOrigins(sources)).toBe("tasks=fallback drivers=fallback decide=fallback");
    expect(typeof sources.createMockDriver).toBe("function");
    expect(typeof sources.createFakeJudge).toBe("function");
    expect(typeof sources.createDecideRuntime).toBe("function");
  });
});

describe("runHarness", () => {
  test("runs the whole matrix offline and writes report.json + report.md", async () => {
    const outBase = await tempDir();
    const scratchBase = await tempDir();
    const taskId = sources.tasks[0]!.id;

    const outcome = await runHarness({
      taskIds: [taskId],
      arms: ["A", "B", "C"],
      runs: 1,
      driverName: "mock",
      sources,
      outBase,
      scratchBase,
      stamp: "STAMP",
    });

    expect(outcome.report.results).toHaveLength(3);
    expect(outcome.report.results.map((result) => result.arm)).toEqual(["A", "B", "C"]);
    expect(outcome.report.summary.A.runs).toBe(1);
    expect(outcome.report.summary.B.runs).toBe(1);
    expect(outcome.report.summary.C.runs).toBe(1);
    expect(outcome.report.results.every((result) => result.ok)).toBe(true);
    expect(outcome.report.results.every((result) => result.correctness.passed)).toBe(true);
    expect(outcome.report.results.find((result) => result.arm === "C")!.decideCalls.length).toBeGreaterThan(0);

    const json = JSON.parse(await fs.readFile(outcome.paths.json, "utf8")) as typeof outcome.report;
    expect(json.driver).toBe("mock");
    expect(json.runs).toBe(1);
    expect(json.results).toHaveLength(3);

    const markdown = await fs.readFile(outcome.paths.markdown, "utf8");
    expect(markdown).toContain("Synthetic usage");
    expect(markdown).toContain("## Harness notes");
    expect(outcome.paths.dir).toBe(path.join(outBase, "STAMP"));
  });

  test("every arm-run gets a fresh fixture copy, and the source fixture is never mutated", async () => {
    const scratchBase = await tempDir();
    const outBase = await tempDir();
    const taskId = "fallback-fix-typo";
    const fixtureFile = path.resolve("harness/runner/fallback/fixtures/fix-typo/src/greeting.ts");
    const before = await fs.readFile(fixtureFile, "utf8");

    await runHarness({
      taskIds: [taskId],
      arms: ["A", "C"],
      runs: 2,
      driverName: "mock",
      sources,
      outBase,
      scratchBase,
      keepScratch: true,
      stamp: "STAMP",
    });

    // Both runs/arms ran: each got its own dir with the fixture copied in.
    for (const run of [0, 1]) {
      for (const arm of ["A", "C"]) {
        const file = path.join(scratchBase, taskId, `run-${run}`, arm, "src", "greeting.ts");
        expect(await fs.readFile(file, "utf8")).toContain("greeting");
      }
    }
    // The fixture source (arm A edits the copy, not the original) is untouched.
    expect(await fs.readFile(fixtureFile, "utf8")).toBe(before);
  });

  test("a second run starts from the pristine fixture, not the previous run's mutations", async () => {
    const fixture = await tempDir();
    await writeFiles(fixture, { "counter.txt": "0" });
    const task: TaskDef = testTask({ id: "freshness", fixture, kind: "one-shot" });
    const injected: Sources = {
      tasks: [task],
      getTask: (id) => (id === task.id ? task : undefined),
      // arm A: edit counter.txt 0 -> 1, then stop. A stale (non-fresh) copy would make the edit
      // fail, so `toolFailures === 0` proves each run got a pristine copy.
      createMockDriver: () => replayDriver([
        response("editing", [{ name: "edit", input: { path: "counter.txt", oldString: "0", newString: "1" } }]),
        response("done", []),
      ]),
      createOpenCodeCliDriver,
      createFakeJudge,
      createDecideRuntime,
      origin: { tasks: "fallback", drivers: "fallback", decide: "fallback" },
      warnings: [],
    };

    const scratchBase = await tempDir();
    const outcome = await runHarness({
      taskIds: ["freshness"],
      arms: ["A"],
      runs: 2,
      driverName: "mock",
      sources: injected,
      outBase: await tempDir(),
      scratchBase,
      keepScratch: true,
    });

    expect(outcome.report.results).toHaveLength(2);
    for (const result of outcome.report.results) {
      expect(result.ok).toBe(true);
      expect(result.toolFailures).toBe(0);
    }
    for (const run of [0, 1]) {
      expect(await fs.readFile(path.join(scratchBase, "freshness", `run-${run}`, "A", "counter.txt"), "utf8")).toBe("1");
    }
  });

  test("an unknown task is a loud error", async () => {
    await expect(
      runHarness({
        taskIds: ["nope"],
        arms: ["A"],
        runs: 1,
        driverName: "mock",
        sources,
        outBase: await tempDir(),
        scratchBase: await tempDir(),
      }),
    ).rejects.toThrow(/unknown task "nope"/);
  });

  test("a broken fixture yields a failed result instead of crashing the run", async () => {
    const dir = await tempDir();
    const task: TaskDef = testTask({ id: "broken", fixture: path.join(dir, "does-not-exist") });
    const injected: Sources = {
      tasks: [task],
      getTask: (id) => (id === task.id ? task : undefined),
      createMockDriver,
      createOpenCodeCliDriver,
      createFakeJudge,
      createDecideRuntime,
      origin: { tasks: "fallback", drivers: "fallback", decide: "fallback" },
      warnings: [],
    };

    const outcome = await runHarness({
      taskIds: ["broken"],
      arms: ["A", "B"],
      runs: 1,
      driverName: "mock",
      sources: injected,
      outBase: await tempDir(),
      scratchBase: await tempDir(),
    });

    expect(outcome.report.results).toHaveLength(2);
    for (const result of outcome.report.results) {
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    }
    expect(outcome.report.summary.A.ok).toBe(0);
  });

  test("rejects runs < 1", async () => {
    await expect(
      runHarness({
        taskIds: [sources.tasks[0]!.id],
        arms: ["A"],
        runs: 0,
        driverName: "mock",
        sources,
        outBase: await tempDir(),
        scratchBase: await tempDir(),
      }),
    ).rejects.toThrow(/--runs/);
  });

  test("an injected task with a verify() over the scratch dir is honoured", async () => {
    const dir = await tempDir();
    await writeFiles(dir, { "seed.txt": "seed" });
    const task: TaskDef = testTask({
      id: "local",
      fixture: dir,
      verify: async (scratch) => ({ passed: (await fs.readFile(path.join(scratch, "seed.txt"), "utf8")) === "seed" }),
    });
    const injected: Sources = {
      tasks: [task],
      getTask: (id) => (id === task.id ? task : undefined),
      createMockDriver: () => replayDriver([response("nothing to do", [])]),
      createOpenCodeCliDriver,
      createFakeJudge,
      createDecideRuntime,
      origin: { tasks: "fallback", drivers: "fallback", decide: "fallback" },
      warnings: [],
    };

    const outcome = await runHarness({
      taskIds: ["local"],
      arms: ["A"],
      runs: 1,
      driverName: "mock",
      sources: injected,
      outBase: await tempDir(),
      scratchBase: await tempDir(),
    });

    expect(outcome.report.results[0]!.ok).toBe(true);
    expect(outcome.report.results[0]!.correctness.passed).toBe(true);
  });
});
