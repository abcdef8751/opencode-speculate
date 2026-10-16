/**
 * Loads the frozen cross-module entry points the harness runs against:
 *
 *   - `harness/tasks/index.ts`    → `TASKS`, `getTask`                              (worker D2)
 *   - `harness/drivers/index.ts`  → `createMockDriver`, `createOpenCodeCliDriver`,
 *                                    `createFakeJudge`                              (worker D2)
 *   - `src/decide/index.ts`       → `createDecideRuntime`, `createJevJudge`         (worker A)
 *
 * There is exactly one implementation of each seam. A missing module is a **broken checkout**, not
 * a supported state, so the loader fails with an actionable message naming the file, its owner and
 * the exports it must provide. It never substitutes a stand-in.
 *
 * Every module's shape is asserted on load: a module that exists but does not export a callable
 * `createMockDriver` fails here rather than three arms into a run.
 *
 * OWNER: worker D1.
 */

import type { ModelDriver, TaskDef } from "../types.ts";
import type { DecideRuntimeFactory, Judge } from "../sandbox/decide-port.ts";

/** Where the seams came from. There is only one source now; the field keeps the report explicit. */
export type SeamOrigin = "module";

export type SeamName = "tasks" | "drivers" | "decide";

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
  origin: Record<SeamName, SeamOrigin>;
  warnings: string[];
}

interface SeamSpec {
  name: SeamName;
  specifier: string;
  owner: string;
  exports: string;
}

const SEAMS = {
  tasks: {
    name: "tasks",
    specifier: "../tasks/index.ts",
    owner: "worker D2",
    exports: "`TASKS` (array) and `getTask(id)`",
  },
  drivers: {
    name: "drivers",
    specifier: "../drivers/index.ts",
    owner: "worker D2",
    exports: "`createMockDriver`, `createOpenCodeCliDriver` and `createFakeJudge`",
  },
  decide: {
    name: "decide",
    specifier: "../../src/decide/index.ts",
    owner: "worker A",
    exports: "`createDecideRuntime`",
  },
} as const satisfies Record<SeamName, SeamSpec>;

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "ERR_MODULE_NOT_FOUND" || record.code === "MODULE_NOT_FOUND") return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /cannot find (module|package)|failed to resolve|module not found|does not exist/i.test(message);
}

/**
 * Imports one seam module. A genuinely missing module becomes an actionable error; every other
 * load error (a syntax error in the module, a missing transitive dependency) is rethrown as-is.
 */
async function importSeam(
  spec: SeamSpec,
  resolver: ((specifier: string) => Promise<Record<string, unknown>>) | undefined,
): Promise<Record<string, unknown>> {
  try {
    return await (resolver ?? defaultResolver)(spec.specifier);
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new Error(
        `harness: missing ${spec.specifier} (owned by ${spec.owner}; must export ${spec.exports}). ` +
          `The harness runs only against the real modules — restore that file (or fix its import path) instead of standing in for it. ` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

const defaultResolver = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

export interface LoadSourcesOptions {
  /** Test seam: replaces the dynamic import used for each seam module. */
  resolver?: (specifier: string) => Promise<Record<string, unknown>>;
}

function requireFn(module: Record<string, unknown>, name: string, spec: SeamSpec): (...args: never[]) => unknown {
  const value = module[name];
  if (typeof value !== "function") {
    throw new Error(
      `harness: ${spec.specifier} must export a callable \`${name}\` (got ${typeof value}); ` +
        `${spec.owner} owns that file.`,
    );
  }
  return value as (...args: never[]) => unknown;
}

/** Loads tasks, drivers and the decide runtime from the real modules. */
export async function loadSources(opts: LoadSourcesOptions = {}): Promise<Sources> {
  const warnings: string[] = [];

  const tasksModule = await importSeam(SEAMS.tasks, opts.resolver);
  if (!Array.isArray(tasksModule.TASKS)) {
    throw new Error(`harness: ${SEAMS.tasks.specifier} must export \`TASKS\` as an array of TaskDef`);
  }
  requireFn(tasksModule, "getTask", SEAMS.tasks);
  const tasks = tasksModule.TASKS as readonly TaskDef[];
  const getTask = tasksModule.getTask as (id: string) => TaskDef | undefined;

  const driversModule = await importSeam(SEAMS.drivers, opts.resolver);
  const createMockDriver = requireFn(driversModule, "createMockDriver", SEAMS.drivers) as unknown as Sources["createMockDriver"];
  const createOpenCodeCliDriver = requireFn(driversModule, "createOpenCodeCliDriver", SEAMS.drivers) as unknown as Sources["createOpenCodeCliDriver"];
  const createFakeJudge = requireFn(driversModule, "createFakeJudge", SEAMS.drivers) as unknown as Sources["createFakeJudge"];

  const decideModule = await importSeam(SEAMS.decide, opts.resolver);
  const createDecideRuntime = requireFn(decideModule, "createDecideRuntime", SEAMS.decide) as unknown as DecideRuntimeFactory;
  const namespace = decideModule.DECIDE_NAMESPACE;
  if (namespace !== "typesafe") {
    warnings.push(`src/decide/index.ts exports DECIDE_NAMESPACE=${String(namespace)} (expected "typesafe")`);
  }
  let createJevJudge: Sources["createJevJudge"];
  const jevJudge = decideModule.createJevJudge;
  if (typeof jevJudge === "function") {
    createJevJudge = jevJudge as unknown as Sources["createJevJudge"];
  } else {
    warnings.push(`src/decide/index.ts does not export createJevJudge — arm C will use the fake judge`);
  }

  return {
    tasks,
    getTask,
    createMockDriver,
    createOpenCodeCliDriver,
    createFakeJudge,
    createDecideRuntime,
    ...(createJevJudge === undefined ? {} : { createJevJudge }),
    origin: { tasks: "module", drivers: "module", decide: "module" },
    warnings,
  };
}

/** Human-readable origin note for the CLI and the report. */
export function describeOrigins(sources: Pick<Sources, "origin">): string {
  return (["tasks", "drivers", "decide"] as const)
    .map((key) => `${key}=${sources.origin[key]}`)
    .join(" ");
}
