/**
 * Small deterministic helpers shared by the task `verify()` / `setup()` hooks.
 *
 * Everything here is offline: it only reads/writes the scratch directory the runner hands us
 * and (optionally) runs the fixture's own check script with the current Bun binary.
 *
 * NOTE: `verify()` must never inspect the model transcript — it only inspects the scratch dir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { TaskDef, TaskVerifyResult } from "../types.ts";

/**
 * Offline fake-judge answers a task can carry for arm C.
 *
 * `TaskDef` (`harness/types.ts`, frozen) has no such field, so it is duck-typed: D1's orchestrator
 * (`harness/runner/orchestrate.ts`) reads `(task as TaskDef & { judgeAnswers?: … }).judgeAnswers`
 * and merges it into the fake-judge script. Keys must match the `id`s the canned arm-C program
 * sends to `decide`, because the fake judge throws on unscripted ids.
 */
export interface TaskJudgeAnswers {
  [questionId: string]: { noul?: number; choice?: string; score?: number; confidence?: number };
}

/** A `TaskDef` with the optional, duck-typed offline judge hook. */
export type TaskWithJudgeAnswers = TaskDef & { judgeAnswers?: TaskJudgeAnswers };

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned or was killed (timeout). */
  error?: string;
}

/** Run a fixture script with the *current* Bun binary, isolated to `dir`. */
export function runBunScript(
  dir: string,
  file: string,
  args: readonly string[] = [],
  timeoutMs = 60_000,
): ScriptResult {
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const error =
    res.error !== undefined && res.error !== null
      ? String((res.error as { message?: unknown }).message ?? res.error)
      : undefined;
  return {
    code: res.status ?? -1,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    ...(error ? { error } : {}),
  };
}

export function pass(detail: string): TaskVerifyResult {
  return { passed: true, detail };
}

export function fail(detail: string): TaskVerifyResult {
  return { passed: false, detail };
}

export function readText(absPath: string): string {
  return readFileSync(absPath, "utf8");
}

export function readJson(absPath: string): unknown {
  return JSON.parse(readFileSync(absPath, "utf8")) as unknown;
}

/**
 * Every regular file under `root`, as POSIX-style paths relative to `root`, sorted.
 * Unreadable directories are skipped rather than throwing.
 */
export function listFiles(root: string, predicate?: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const rel = relative(root, abs).split(sep).join("/");
        if (predicate === undefined || predicate(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Recursively sort object keys so two JSON values can be compared order-insensitively. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = sort(src[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function fileExists(...parts: string[]): boolean {
  return existsSync(join(...parts));
}

/** Human-readable one-liner for a failed fixture script. */
export function describeScriptFailure(res: ScriptResult): string {
  const bits = [res.error, res.stderr.trim(), res.stdout.trim()].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return bits.join(" | ") || "no output";
}
