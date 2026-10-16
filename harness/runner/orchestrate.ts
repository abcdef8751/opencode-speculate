/**
 * Orchestrates the measurement matrix: tasks × runs × arms, one fresh scratch dir per arm-run.
 *
 * OWNER: worker D1.
 */

import type { ArmID, ArmResult, ModelDriver, RunReport, TaskDef, ToolBox } from "../types.ts";
import { createToolBox } from "../sandbox/index.ts";
import { summariseByArm } from "../metrics/index.ts";
import { writeReport, type ReportPaths } from "../report.ts";
import { runArm, type ArmContext } from "./arms/index.ts";
import { DEFAULT_MAX_TURNS, emptyResult } from "./results.ts";
import { createScratchDir, defaultScratchBase, removeScratchDir } from "./scratch.ts";
import { loadSources, type Sources } from "./sources.ts";
import type { Judge } from "../sandbox/decide-port.ts";

export interface RunHarnessOptions {
  taskIds: readonly string[];
  arms: readonly ArmID[];
  runs: number;
  /** "mock" (offline) or "opencode" (live CLI). */
  driverName: string;
  maxTurns?: number;
  seed?: number;
  outBase?: string;
  stamp?: string;
  scratchBase?: string;
  keepScratch?: boolean;
  /** Injected for tests; otherwise loaded from the frozen modules (see `./sources.ts`). */
  sources?: Sources;
  signal?: AbortSignal;
  /** Extra answers for the offline fake judge (arm C). */
  judgeScript?: Record<string, { noul?: number; choice?: string; score?: number; confidence?: number }>;
  /** Canned per-task programs for the mock driver (`programs` passthrough). */
  mockPrograms?: Record<string, { A?: string; B?: string; C?: string }>;
  /** API key for the real Jev judge; ignored for `--driver mock` so mock runs stay offline. */
  apiKey?: string;
  createJevJudge?: (opts: { apiKey: string; baseURL?: string; model?: string }) => Judge;
}

export interface RunOutcome {
  report: RunReport;
  paths: ReportPaths;
  sources: Sources;
  scratchBase: string;
  warnings: string[];
}

const API_KEY_ENV = ["OPENCODE_API_KEY", "TYPESAFE_API_KEY"] as const;

function apiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  for (const key of API_KEY_ENV) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Answers a task optionally carries for the offline fake judge (duck-typed, optional). */
function taskJudgeScript(task: TaskDef): Record<string, { noul?: number; choice?: string; score?: number; confidence?: number }> {
  const extra = (task as TaskDef & { judgeAnswers?: Record<string, { noul?: number; choice?: string; score?: number; confidence?: number }> })
    .judgeAnswers;
  return extra ?? {};
}

function failureResult(arm: ArmID, task: TaskDef, runIndex: number, error: unknown): ArmResult {
  const result = emptyResult(arm, task.id, runIndex);
  const message = error instanceof Error ? error.message : String(error);
  result.error = message;
  result.notes.push(`harness-level error: ${message}`);
  return result;
}

/** Runs the requested matrix and writes `out/<stamp>/report.json` + `report.md`. */
export async function runHarness(opts: RunHarnessOptions): Promise<RunOutcome> {
  if (opts.runs < 1) throw new Error("--runs must be >= 1");
  const sources = opts.sources ?? (await loadSources());
  const warnings = [...sources.warnings];
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const scratchBase = opts.scratchBase ?? defaultScratchBase(stamp);
  const startedAt = new Date().toISOString();

  const tasks = opts.taskIds.map((id) => {
    const task = sources.getTask(id);
    if (task === undefined) {
      throw new Error(`unknown task "${id}" (known: ${sources.tasks.map((entry) => entry.id).join(", ")})`);
    }
    return task;
  });

  // Arm C always uses the offline fake judge for `--driver mock`, even when an API key is present,
  // so a mock run never touches the network.
  const apiKey = opts.apiKey ?? apiKeyFromEnv(process.env);
  const createJevJudge = opts.createJevJudge ?? sources.createJevJudge;
  const useRealJudge = opts.driverName !== "mock" && apiKey !== undefined && createJevJudge !== undefined;
  if (opts.driverName !== "mock" && apiKey !== undefined && createJevJudge === undefined) {
    warnings.push("an API key is configured but `createJevJudge` is unavailable — arm C uses the offline fake judge");
  }
  if (opts.driverName !== "mock" && apiKey === undefined) {
    warnings.push("no API key configured — arm C uses the offline fake judge");
  }

  const results: ArmResult[] = [];
  for (const task of tasks) {
    for (let runIndex = 0; runIndex < opts.runs; runIndex += 1) {
      for (const arm of opts.arms) {
        let scratchDir: string | undefined;
        try {
          scratchDir = await createScratchDir({ task, runIndex, arm, base: scratchBase });
        } catch (error) {
          results.push(failureResult(arm, task, runIndex, error));
          continue;
        }

        let toolbox: ToolBox | undefined;
        try {
          toolbox = createToolBox({ dir: scratchDir, ...(task.tools === undefined ? {} : { names: [...task.tools] }) });
        } catch (error) {
          results.push(failureResult(arm, task, runIndex, error));
          if (opts.keepScratch !== true) await removeScratchDir(scratchDir);
          continue;
        }

        let driver: ModelDriver;
        try {
          driver =
            opts.driverName === "opencode"
              ? sources.createOpenCodeCliDriver()
              : sources.createMockDriver({
                  seed: opts.seed ?? 1,
                  ...(opts.mockPrograms === undefined ? {} : { programs: opts.mockPrograms }),
                });
        } catch (error) {
          results.push(failureResult(arm, task, runIndex, error));
          if (opts.keepScratch !== true) await removeScratchDir(scratchDir);
          continue;
        }

        let judge: Judge | undefined;
        if (arm === "C") {
          judge = useRealJudge && createJevJudge !== undefined && apiKey !== undefined
            ? createJevJudge({ apiKey })
            : sources.createFakeJudge({ ...taskJudgeScript(task), ...(opts.judgeScript ?? {}) });
        }

        const ctx: ArmContext = {
          driver,
          toolbox,
          task,
          runIndex,
          maxTurns,
          createDecideRuntime: arm === "C" ? sources.createDecideRuntime : undefined,
          judge,
          modelId: driver.id,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        };

        let result: ArmResult;
        try {
          result = await runArm(arm, ctx);
        } catch (error) {
          result = failureResult(arm, task, runIndex, error);
        }
        results.push(result);

        if (opts.keepScratch !== true) await removeScratchDir(scratchDir);
      }
    }
  }

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    driver: opts.driverName,
    runs: opts.runs,
    results,
    summary: summariseByArm(results),
  };

  const reportNotes = [
    ...warnings,
    `modules: ${(["tasks", "drivers", "decide"] as const).map((key) => `${key}=${sources.origin[key]}`).join(" ")}`,
    `maxTurns=${maxTurns}`,
  ];
  const paths = await writeReport({
    report,
    outBase: opts.outBase ?? "out",
    stamp,
    notes: reportNotes,
  });

  return { report, paths, sources, scratchBase, warnings: reportNotes };
}
