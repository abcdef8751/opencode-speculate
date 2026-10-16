/**
 * Per-run scratch directories: a fresh copy of the task fixture the tools are confined to.
 *
 * OWNER: worker D1.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TaskDef } from "../types.ts";

/** Repo root inferred from this module's location (`harness/runner/`). */
export function repoRoot(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

/** Default scratch base: `/tmp/opencode/harness-runs/<stamp>/…`. */
export function defaultScratchBase(stamp: string): string {
  const tmp = process.env.TMPDIR !== undefined && process.env.TMPDIR.length > 0 ? process.env.TMPDIR : "/tmp";
  return path.join(tmp, "opencode", "harness-runs", stamp);
}

function safeSegment(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

export interface ScratchRequest {
  task: TaskDef;
  runIndex: number;
  arm: string;
  base: string;
  root?: string;
}

/** Copies the fixture into a fresh scratch directory and runs `task.setup` on it. */
export async function createScratchDir(req: ScratchRequest): Promise<string> {
  const root = req.root ?? repoRoot();
  const fixture = path.isAbsolute(req.task.fixture) ? req.task.fixture : path.resolve(root, req.task.fixture);
  const dir = path.join(req.base, safeSegment(req.task.id), `run-${req.runIndex}`, req.arm);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.cp(fixture, dir, { recursive: true });
  if (req.task.setup !== undefined) await req.task.setup(dir);
  return dir;
}

/** Best-effort removal of a scratch directory. */
export async function removeScratchDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
