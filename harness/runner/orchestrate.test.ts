import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runHarness } from "./orchestrate.ts";
import { loadSources, describeOrigins, type Sources } from "./sources.ts";
import { parseArmMarker } from "./arms/context.ts";
import { loadSources as loadReal } from "./sources.ts";
import { cleanupTempDirs, replayDriver, response, tempDir, testTask, writeFiles } from "./testing.ts";
import type { ModelDriver, TaskDef } from "../types.ts";

afterAll(cleanupTempDirs);

const sources = await loadSources();

/** Injected sources: a hermetic task + driver, wired to the real drivers/decide runtime. */
function injectedSources(task: TaskDef, createMockDriverFor: () => ModelDriver, extra: Partial<Sources> = {}): Sources {
  return {
    tasks: [task],
    getTask: (id) => (id === task.id ? task : undefined),
    createMockDriver: createMockDriverFor,
    createOpenCodeCliDriver: sources.createOpenCodeCliDriver,
    createFakeJudge: sources.createFakeJudge,
    createDecideRuntime: sources.createDecideRuntime,
    origin: { tasks: "module", drivers: "module", decide: "module" },
    warnings: [],
    ...extra,
  };
}

describe("module sources", () => {
  test("expose the frozen surface of the three real modules", () => {
    expect(sources.tasks.length).toBeGreaterThan(0);
    expect(sources.tasks.every((task) => typeof task.id === "string" && typeof task.verify === "function")).toBe(true);
    expect(typeof sources.getTask).toBe("function");
    expect(typeof sources.createMockDriver).toBe("function");
    expect(typeof sources.createOpenCodeCliDriver).toBe("function");
    expect(typeof sources.createFakeJudge).toBe("function");
    expect(typeof sources.createDecideRuntime).toBe("function");
    expect(describeOrigins(sources)).toBe("tasks=module drivers=module decide=module");
    expect(sources.warnings).toEqual([]);
  });

  test("a genuinely missing module fails with an actionable error, and is never stood in for", async () => {
    const notFound = Object.assign(new Error("Cannot find module '../tasks/index.ts'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(loadReal({ resolver: async () => Promise.reject(notFound) })).rejects.toThrow(
      /missing \.\.\/tasks\/index\.ts \(owned by worker D2; must export `TASKS` \(array\) and `getTask\(id\)`\)/,
    );
    await expect(loadReal({ resolver: async () => Promise.reject(notFound) })).rejects.toThrow(
      /runs only against the real modules/,
    );
  });

  test("a module that exists but exports the wrong shape is a loud error too", async () => {
    await expect(loadReal({ resolver: async () => ({}) })).rejects.toThrow(/must export `TASKS` as an array/);
    await expect(
      loadReal({
        resolver: async (specifier) =>
          specifier.includes("tasks") ? { TASKS: [], getTask: () => undefined } : {},
      }),
    ).rejects.toThrow(/must export a callable `createMockDriver`/);
  });
});

describe("runHarness", () => {
  test("runs the whole matrix offline and writes report.json + report.md", async () => {
    const fixture = await tempDir();
    await writeFiles(fixture, { "in.txt": "seed" });
    const task: TaskDef = testTask({
      id: "hermetic",
      fixture,
      scriptPrompt: "write one script",
      verify: async (dir) => ({ passed: (await fs.readFile(path.join(dir, "in.txt"), "utf8")) === "seed" }),
    });
    // One driver for all arms. It reads the informational `harness:arm=…` marker (the sandbox has
    // no arm field on ModelDriver); a real driver would use the tool list + prompt instead.
    const driver: ModelDriver = {
      id: "hermetic-mock",
      async complete(req) {
        const marker = parseArmMarker(req.messages[0]?.text);
        if (marker?.arm === "A") {
          const turn = req.messages.filter((message) => message.role === "assistant").length;
          return turn === 0
            ? response("working", [{ name: "read", input: { path: "in.txt" } }])
            : response("done", []);
        }
        if (marker?.arm === "C") {
          return response(
            'const d = await tools.typesafe.decide({ state: { n: 1 }, questions: { mode: "noul", id: "q1", criteria: { true: "a", false: "b" } } }); return d.value;',
            [],
          );
        }
        return response("const ok = 1 + 1 === 2; return ok;", []);
      },
    };

    const outBase = await tempDir();
    const scratchBase = await tempDir();
    const outcome = await runHarness({
      taskIds: ["hermetic"],
      arms: ["A", "B", "C"],
      runs: 1,
      driverName: "mock",
      sources: injectedSources(task, () => driver),
      // The real fake judge fails loud on unscripted question ids, so supply the answer arm C asks for.
      judgeScript: { q1: { noul: 0.95, confidence: 0.9 } },
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
    expect(outcome.report.results.find((result) => result.arm === "A")!.turns).toBe(2);

    const json = JSON.parse(await fs.readFile(outcome.paths.json, "utf8")) as typeof outcome.report;
    expect(json.driver).toBe("mock");
    expect(json.runs).toBe(1);
    expect(json.results).toHaveLength(3);

    const markdown = await fs.readFile(outcome.paths.markdown, "utf8");
    expect(markdown).toContain("Synthetic usage");
    expect(markdown).toContain("## Harness notes");
    expect(outcome.paths.dir).toBe(path.join(outBase, "STAMP"));
  });

  test("the loaded modules run end-to-end for the first available task", async () => {
    const outBase = await tempDir();
    const outcome = await runHarness({
      taskIds: [sources.tasks[0]!.id],
      arms: ["A", "B", "C"],
      runs: 1,
      driverName: "mock",
      sources,
      outBase,
      scratchBase: await tempDir(),
      stamp: "STAMP",
    });
    expect(outcome.report.results).toHaveLength(3);
    expect(await fs.readFile(outcome.paths.json, "utf8")).toContain('"results"');
    expect(await fs.readFile(outcome.paths.markdown, "utf8")).toContain("# Code Mode harness report");
  });

  test("the fixture source is copied per arm-run and never mutated", async () => {
    const fixture = await tempDir();
    await writeFiles(fixture, { "data.txt": "original" });
    const task: TaskDef = testTask({
      id: "untouched",
      fixture,
      verify: async (dir) => ({ passed: (await fs.readFile(path.join(dir, "data.txt"), "utf8")) === "original" }),
    });
    const injected = injectedSources(task, () =>
      replayDriver([
        response("clobbering", [{ name: "write", input: { path: "data.txt", content: "clobbered" } }]),
        response("done", []),
      ]),
    );

    const scratchBase = await tempDir();
    const outcome = await runHarness({
      taskIds: ["untouched"],
      arms: ["A"],
      runs: 2,
      driverName: "mock",
      sources: injected,
      outBase: await tempDir(),
      scratchBase,
      keepScratch: true,
    });

    expect(outcome.report.results).toHaveLength(2);
    for (const result of outcome.report.results) expect(result.toolFailures).toBe(0);
    // The scratch copies were mutated...
    for (const run of [0, 1]) {
      expect(await fs.readFile(path.join(scratchBase, "untouched", `run-${run}`, "A", "data.txt"), "utf8")).toBe("clobbered");
    }
    // ...but the fixture the runner copied from was not.
    expect(await fs.readFile(path.join(fixture, "data.txt"), "utf8")).toBe("original");
    expect((await fs.readdir(fixture)).sort()).toEqual(["data.txt"]);
  });

  test("a second run starts from the pristine fixture, not the previous run's mutations", async () => {
    const fixture = await tempDir();
    await writeFiles(fixture, { "counter.txt": "0" });
    const task: TaskDef = testTask({ id: "freshness", fixture, kind: "one-shot" });
    // arm A: edit counter.txt 0 -> 1, then stop. A stale (non-fresh) copy would make the edit
    // fail, so `toolFailures === 0` proves each run got a pristine copy.
    const injected = injectedSources(task, () =>
      replayDriver([
        response("editing", [{ name: "edit", input: { path: "counter.txt", find: "0", replace: "1" } }]),
        response("done", []),
      ]),
    );

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
    const outcome = await runHarness({
      taskIds: ["broken"],
      arms: ["A", "B"],
      runs: 1,
      driverName: "mock",
      sources: injectedSources(task, () => sources.createMockDriver()),
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
    const outcome = await runHarness({
      taskIds: ["local"],
      arms: ["A"],
      runs: 1,
      driverName: "mock",
      sources: injectedSources(task, () => replayDriver([response("nothing to do", [])])),
      outBase: await tempDir(),
      scratchBase: await tempDir(),
    });

    expect(outcome.report.results[0]!.ok).toBe(true);
    expect(outcome.report.results[0]!.correctness.passed).toBe(true);
  });
});
