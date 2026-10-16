/**
 * Loads the frozen cross-module entry points, preferring the real modules and falling back to the
 * offline dev shim in `./fallback/**` when a module is missing from this worktree.
 *
 * Why the fallback: D1's worktree is cut from the scaffold commit, so `harness/tasks/index.ts`
 * (D2), `harness/drivers/index.ts` (D2) and `src/decide/index.ts` (A) do not exist yet. The
 * harness must still satisfy its definition of done — an offline `--driver mock` run that writes
 * both report files — without D1 creating files it does not own.
 *
 * Behaviour:
 *  - module present  → used, and its shape is asserted (missing exports are a loud error);
 *  - module absent   → the fallback is used, and a warning is recorded (the report and the CLI say
 *                      so, so nobody mistakes shim numbers for D2/A behaviour).
 * Only "module not found" triggers the fallback; any other load error is rethrown.
 *
 * OWNER: worker D1.
 */

import type { ModelDriver, TaskDef } from "../types.ts";
import type { DecideRuntimeFactory, Judge } from "../sandbox/decide-port.ts";

/** Where each seam came from. */
export type SeamOrigin = "module" | "fallback";

export interface Sources {
  tasks: readonly TaskDef[];
  getTask(id: string): TaskDef | undefined;
  createMockDriver(opts?: {
    seed?: number;
    programs?: Record<string, { A?: string; B?: string; C?: string }>;
    usageModel?: "small" | "cached-heavy";
  }): ModelDriver;
  createOpenCodeCliDriver(opts?: { model?: string; agent?: string; binary?: string }): ModelDriver;
  createFakeJudge(script: Record<string, { noul?: number; choice?: string; score?: number; confidence?: number }>): Judge;
  createDecideRuntime: DecideRuntimeFactory;
  /** Present only when `src/decide/index.ts` exists and exports it. */
  createJevJudge?: ((opts: { apiKey: string; baseURL?: string; model?: string }) => Judge) | undefined;
  origin: { tasks: SeamOrigin; drivers: SeamOrigin; decide: SeamOrigin };
  warnings: string[];
}

const TASKS_SPEC = "../tasks/index.ts";
const DRIVERS_SPEC = "../drivers/index.ts";
const DECIDE_SPEC = "../../src/decide/index.ts";

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  if (record.code === "ERR_MODULE_NOT_FOUND" || record.code === "MODULE_NOT_FOUND") return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /cannot find (module|package)|failed to resolve|module not found|does not exist/i.test(message);
}

async function importOrFallback(spec: string): Promise<{ module?: Record<string, unknown>; missing: boolean }> {
  try {
    const loaded = (await import(spec)) as Record<string, unknown>;
    return { module: loaded, missing: false };
  } catch (error) {
    if (isModuleNotFound(error)) return { missing: true };
    throw error;
  }
}

function requireFn(module: Record<string, unknown>, name: string, spec: string): (...args: never[]) => unknown {
  const value = module[name];
  if (typeof value !== "function") {
    throw new Error(`${spec} exists but does not export a callable \`${name}\` (got ${typeof value})`);
  }
  return value as (...args: never[]) => unknown;
}

/** Loads tasks, drivers and the decide runtime, preferring the real modules. */
export async function loadSources(): Promise<Sources> {
  const warnings: string[] = [];

  const tasksLoaded = await importOrFallback(TASKS_SPEC);
  let tasks: readonly TaskDef[];
  let getTask: (id: string) => TaskDef | undefined;
  const tasksOrigin: SeamOrigin = tasksLoaded.missing ? "fallback" : "module";
  if (tasksLoaded.module !== undefined) {
    const module = tasksLoaded.module;
    if (!Array.isArray(module.TASKS)) throw new Error(`${TASKS_SPEC} must export \`TASKS\` as an array`);
    requireFn(module, "getTask", TASKS_SPEC);
    tasks = module.TASKS as readonly TaskDef[];
    getTask = module.getTask as (id: string) => TaskDef | undefined;
  } else {
    warnings.push(`harness/tasks/index.ts missing — using D1 fallback tasks`);
    const fallback = await import("./fallback/tasks.ts");
    tasks = fallback.TASKS;
    getTask = fallback.getTask;
  }

  const driversLoaded = await importOrFallback(DRIVERS_SPEC);
  let createMockDriver: Sources["createMockDriver"];
  let createOpenCodeCliDriver: Sources["createOpenCodeCliDriver"];
  let createFakeJudge: Sources["createFakeJudge"];
  const driversOrigin: SeamOrigin = driversLoaded.missing ? "fallback" : "module";
  if (driversLoaded.module !== undefined) {
    createMockDriver = requireFn(driversLoaded.module, "createMockDriver", DRIVERS_SPEC) as unknown as Sources["createMockDriver"];
    createOpenCodeCliDriver = requireFn(
      driversLoaded.module,
      "createOpenCodeCliDriver",
      DRIVERS_SPEC,
    ) as unknown as Sources["createOpenCodeCliDriver"];
    createFakeJudge = requireFn(driversLoaded.module, "createFakeJudge", DRIVERS_SPEC) as unknown as Sources["createFakeJudge"];
  } else {
    warnings.push(`harness/drivers/index.ts missing — using D1 fallback mock driver + fake judge`);
    const fallback = await import("./fallback/drivers.ts");
    createMockDriver = fallback.createMockDriver;
    createOpenCodeCliDriver = fallback.createOpenCodeCliDriver;
    createFakeJudge = fallback.createFakeJudge;
  }

  const decideLoaded = await importOrFallback(DECIDE_SPEC);
  let createDecideRuntime: DecideRuntimeFactory;
  let createJevJudge: Sources["createJevJudge"];
  const decideOrigin: SeamOrigin = decideLoaded.missing ? "fallback" : "module";
  if (decideLoaded.module !== undefined) {
    createDecideRuntime = requireFn(decideLoaded.module, "createDecideRuntime", DECIDE_SPEC) as unknown as DecideRuntimeFactory;
    const namespace = decideLoaded.module.DECIDE_NAMESPACE;
    if (namespace !== "typesafe") {
      warnings.push(`src/decide/index.ts exports DECIDE_NAMESPACE=${String(namespace)} (expected "typesafe")`);
    }
    const jevJudge = decideLoaded.module.createJevJudge;
    if (typeof jevJudge === "function") {
      createJevJudge = jevJudge as unknown as Sources["createJevJudge"];
    } else {
      warnings.push(`src/decide/index.ts does not export createJevJudge — arm C will use the fake judge`);
    }
  } else {
    warnings.push(`src/decide/index.ts missing — using D1 decide dev shim for arm C`);
    const fallback = await import("./fallback/decide.ts");
    createDecideRuntime = fallback.createDecideRuntime;
  }

  return {
    tasks,
    getTask,
    createMockDriver,
    createOpenCodeCliDriver,
    createFakeJudge,
    createDecideRuntime,
    ...(createJevJudge === undefined ? {} : { createJevJudge }),
    origin: { tasks: tasksOrigin, drivers: driversOrigin, decide: decideOrigin },
    warnings,
  };
}

/** Human-readable origin note for the CLI and the report. */
export function describeOrigins(sources: Pick<Sources, "origin">): string {
  return (["tasks", "drivers", "decide"] as const)
    .map((key) => `${key}=${sources.origin[key]}`)
    .join(" ");
}
