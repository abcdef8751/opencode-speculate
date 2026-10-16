/**
 * The frozen task catalog. Worker D1 (`harness/runner/**`, `harness/run.ts`) imports
 * `TASKS` and `getTask` from here and must not need anything else.
 *
 * Every task's `fixture` is a path relative to the repo root; the runner copies it
 * into a fresh scratch directory per run and calls `setup?()` / `verify(dir)` there.
 */
import type { TaskDef } from "../types.ts";
import { deprecatedAudit } from "./deprecated-audit.ts";
import { fixMedian } from "./fix-median.ts";
import { logTriage } from "./log-triage.ts";
import { migrateConfig } from "./migrate-config.ts";
import { renameSymbol } from "./rename-symbol.ts";

/**
 * Three `long-loop` tasks (multi-file rename, log triage, deprecated audit), one
 * `medium` (fix a failing check) and one `one-shot` (config migration).
 *
 * The `long-loop` tasks are the ones the plan's cache-read hypothesis is about:
 * they cannot be answered without reading/grepping many files.
 */
export const TASKS: readonly TaskDef[] = [
  migrateConfig,
  fixMedian,
  renameSymbol,
  logTriage,
  deprecatedAudit,
];

export function getTask(id: string): TaskDef | undefined {
  return TASKS.find((task) => task.id === id);
}
