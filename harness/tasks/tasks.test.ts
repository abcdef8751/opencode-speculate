/**
 * D2 task tests.
 *
 * These are offline and deterministic: they copy a fixture into a scratch dir, mutate the
 * copy, and assert what `verify()` reports. No network, no model.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, getTask } from "./index.ts";
import type { TaskDef } from "../types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TMP_ROOT = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();

const created: string[] = [];

function scratch(task: TaskDef): string {
  const dir = mkdtempSync(join(TMP_ROOT, `d2-${task.id}-`));
  cpSync(join(REPO_ROOT, task.fixture), dir, { recursive: true });
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** The minimal, self-contained "solve" recipe used to prove `verify()` says yes. */
async function solve(task: TaskDef, dir: string): Promise<void> {
  switch (task.id) {
    case "fix-median": {
      const path = join(dir, "src", "stats.mjs");
      writeFileSync(path, readFileSync(path, "utf8").replace("values.length - 1", "values.length"));
      return;
    }
    case "migrate-config": {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify(
          {
            logging: { level: "debug" },
            network: { retries: 3, timeoutMs: 1500 },
            features: ["cache", "metrics"],
          },
          null,
          2,
        ),
      );
      return;
    }
    case "log-triage": {
      writeFileSync(
        join(dir, "triage.json"),
        JSON.stringify({
          filesScanned: 10,
          totalErrors: 42,
          codes: { E100: 14, E104: 17, E204: 5, E401: 6 },
          topCode: "E104",
        }),
      );
      return;
    }
    case "deprecated-audit": {
      writeFileSync(
        join(dir, "audit.json"),
        JSON.stringify({
          deprecated: ["src/cache.mjs", "src/db.mjs", "src/logger.mjs", "src/queue.mjs", "src/session.mjs"],
          deprecatedCount: 5,
          todoCounts: {
            "src/auth.mjs": 1,
            "src/cache.mjs": 2,
            "src/db.mjs": 1,
            "src/http.mjs": 3,
            "src/logger.mjs": 1,
            "src/search.mjs": 2,
          },
          topTodo: "src/http.mjs",
        }),
      );
      return;
    }
    case "rename-symbol": {
      const pkg = join(dir, "pkg");
      for (const name of readdirSync(pkg)) {
        if (!name.endsWith(".mjs")) continue;
        const path = join(pkg, name);
        const next = readFileSync(path, "utf8").replace(/\blegacyRate\b/g, "rollingRate");
        writeFileSync(path, next);
      }
      return;
    }
    default:
      throw new Error(`no solve recipe for task ${task.id}`);
  }
}

describe("TASKS catalog", () => {
  test("is non-empty and within the 4–5 range", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(4);
    expect(TASKS.length).toBeLessThanOrEqual(5);
  });

  test("every id is unique and every task is well-formed", () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of TASKS) {
      expect(typeof task.id).toBe("string");
      expect(task.id.length).toBeGreaterThan(0);
      expect(["long-loop", "medium", "one-shot"]).toContain(task.kind);
      expect(task.title.length).toBeGreaterThan(0);
      expect(task.prompt.trim().length).toBeGreaterThan(0);
      expect(task.scriptPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  test("at least two long-loop tasks exist", () => {
    expect(TASKS.filter((t) => t.kind === "long-loop").length).toBeGreaterThanOrEqual(2);
  });

  test("at least one long-loop task has an escalationPrompt", () => {
    const withEscalation = TASKS.filter(
      (t) => t.kind === "long-loop" && (t.escalationPrompt ?? "").trim().length > 0,
    );
    expect(withEscalation.length).toBeGreaterThanOrEqual(1);
  });

  test("every escalationPrompt mentions decide and the escalate/break handler", () => {
    for (const task of TASKS) {
      const prompt = task.escalationPrompt;
      if (prompt === undefined) continue;
      expect(prompt).toContain("tools.typesafe.decide");
      expect(prompt).toContain("escalate");
      expect(prompt).toContain("break");
    }
  });

  test("every fixture directory exists and is non-empty", () => {
    for (const task of TASKS) {
      const dir = join(REPO_ROOT, task.fixture);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    }
  });

  test("no fixture file matches Bun's test-discovery glob", () => {
    // A failing fixture named *.test.ts would be picked up by a bare `bun test`.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/[._](test|spec)\./i.test(entry.name)) offenders.push(abs);
      }
    };
    walk(join(REPO_ROOT, "harness", "fixtures"));
    expect(offenders).toEqual([]);
  });

  test("getTask finds a known id and returns undefined for a miss", () => {
    const first = TASKS[0] as TaskDef;
    expect(getTask(first.id)).toBe(first);
    expect(getTask("no-such-task")).toBeUndefined();
  });
});

describe("verify() against scratch copies", () => {
  for (const task of TASKS) {
    test(`${task.id}: fails on the pristine copy, passes once solved`, async () => {
      const broken = scratch(task);
      if (task.setup !== undefined) await task.setup(broken);
      const brokenResult = await task.verify(broken);
      expect(brokenResult.passed).toBe(false);
      expect(typeof brokenResult.detail).toBe("string");

      const good = scratch(task);
      if (task.setup !== undefined) await task.setup(good);
      await solve(task, good);
      const goodResult = await task.verify(good);
      expect(goodResult.detail ?? "").toBeString();
      expect(goodResult.passed).toBe(true);
    });
  }

  test("setup() only mutates the scratch copy, never the fixture", async () => {
    const task = getTask("rename-symbol") as TaskDef;
    expect(task.setup).toBeDefined();
    const fixtureBefore = readdirSync(join(REPO_ROOT, task.fixture, "pkg")).sort();
    const dir = scratch(task);
    await (task.setup as NonNullable<TaskDef["setup"]>)(dir);
    expect(existsSync(join(dir, "pkg", "mod12.mjs"))).toBe(true);
    const fixtureAfter = readdirSync(join(REPO_ROOT, task.fixture, "pkg")).sort();
    expect(fixtureAfter).toEqual(fixtureBefore);
  });

  test("rename-symbol verify() still fails when the injected mod12 is left alone", async () => {
    const task = getTask("rename-symbol") as TaskDef;
    const dir = scratch(task);
    await (task.setup as NonNullable<TaskDef["setup"]>)(dir);
    await solve(task, dir);
    // Put the injected file back in its pre-rename state: a rename that ignored it must fail.
    writeFileSync(
      join(dir, "pkg", "mod12.mjs"),
      ['import { legacyRate } from "./core.mjs";', "", "export const value12 = legacyRate(12);", ""].join("\n"),
    );
    const result = await task.verify(dir);
    expect(result.passed).toBe(false);
  });
});
