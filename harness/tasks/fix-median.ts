/**
 * Task: `fix-median` (medium).
 *
 * A tiny statistics module whose check script fails. The defect is a real,
 * single-line divisor bug. `verify()` runs the fixture's own check script in the
 * scratch copy — the model's transcript is never consulted.
 */
import { join } from "node:path";
import type { TaskDef, TaskVerifyResult } from "../types.ts";
import { describeScriptFailure, fail, fileExists, pass, runBunScript } from "./util.ts";

const SHARED_RULES = [
  "Work only inside the current directory; do not reach outside it.",
  "Do not edit `check.mjs`.",
  "When you are done, `bun check.mjs` must exit 0.",
];

export const fixMedian: TaskDef = {
  id: "fix-median",
  title: "Fix the failing statistics check",
  kind: "medium",
  fixture: "harness/fixtures/buggy-stats",
  tools: ["read", "grep", "glob", "edit", "write", "shell"],
  prompt: [
    "You are working in a small JavaScript project.",
    "`bun check.mjs` currently fails.",
    "Find the defect somewhere under `src/` and fix the source so that the check passes.",
    ...SHARED_RULES,
  ].join("\n"),
  scriptPrompt: [
    "You are working in a small JavaScript project.",
    "`bun check.mjs` currently fails because of a defect under `src/`.",
    "Write ONE Code Mode program (JavaScript) that finds and fixes the defect in a single script.",
    "Inside the program the sandbox tools are available as `await tools.<name>({ ... })`, e.g.",
    "`await tools.read({ path: \"src/stats.mjs\" })`, `await tools.glob({ pattern: \"src/**/*.mjs\" })`,",
    "`await tools.grep({ pattern: \"length\", path: \"src\" })` and",
    "`await tools.write({ path: \"src/stats.mjs\", content: \"...\" })`.",
    "Return a small JSON object describing what you changed.",
    ...SHARED_RULES,
  ].join("\n"),
  async verify(dir: string): Promise<TaskVerifyResult> {
    if (!fileExists(dir, "src", "stats.mjs")) return fail("src/stats.mjs is missing from the scratch copy");
    if (!fileExists(dir, "check.mjs")) return fail("check.mjs is missing from the scratch copy");
    const res = runBunScript(dir, "check.mjs");
    if (res.code !== 0) return fail(`check.mjs exited ${res.code}: ${describeScriptFailure(res)}`);
    return pass(res.stdout.trim() || "check.mjs exited 0");
  },
};
