/**
 * Task: `migrate-config` (one-shot).
 *
 * Rewrite a flat v1 JSON config into the grouped v2 shape. One read, one write —
 * the cheapest task in the set, and the baseline arm-A cost floor.
 */
import { join } from "node:path";
import type { TaskVerifyResult } from "../types.ts";
import { fail, fileExists, jsonEqual, pass, readJson, type TaskWithJudgeAnswers } from "./util.ts";

/** Expected `config.json` after migration; keep in sync with `harness/fixtures/config-migrate`. */
export const MIGRATE_CONFIG_EXPECTED = {
  logging: { level: "debug" },
  network: { retries: 3, timeoutMs: 1500 },
  features: ["cache", "metrics"],
} as const;

const SHAPE = [
  "Rewrite `config.json` in place into the v2 shape documented in `config.schema.md`:",
  '  { "logging": { "level": <string> }, "network": { "retries": <int>, "timeoutMs": <int> }, "features": [<string>, ...] }',
  "Keep every value exactly as it is — only the shape changes.",
  "The result must have exactly those three top-level keys: no `logLevel`, `retries` or `timeoutMs` at the top level.",
];

export const migrateConfig: TaskWithJudgeAnswers = {
  id: "migrate-config",
  title: "Migrate a flat config to the grouped v2 shape",
  kind: "one-shot",
  fixture: "harness/fixtures/config-migrate",
  tools: ["read", "write"],
  /** Offline judge answers for the canned arm-C program (non-escalating: no `escalateBelow`). */
  judgeAnswers: { actionable: { noul: 0.95, confidence: 0.9 } },
  prompt: [
    "You are working in a tiny project whose configuration is out of date.",
    "`README.md` and `config.schema.md` describe the target shape.",
    ...SHAPE,
  ].join("\n"),
  scriptPrompt: [
    "You are working in a tiny project whose configuration is out of date.",
    "Write ONE Code Mode program (JavaScript) that reads `config.json` and writes it back in the target shape.",
    "The sandbox tools are available as `await tools.<name>({ ... })`, e.g.",
    '`await tools.read({ path: "config.json" })` and',
    '`await tools.write({ path: "config.json", content: JSON.stringify(next, null, 2) })`.',
    "Return a small JSON object describing the migration.",
    ...SHAPE,
  ].join("\n"),
  async verify(dir: string): Promise<TaskVerifyResult> {
    if (!fileExists(dir, "config.json")) return fail("config.json is missing from the scratch copy");
    let actual: unknown;
    try {
      actual = readJson(join(dir, "config.json"));
    } catch (err) {
      return fail(`config.json is not valid JSON: ${String(err)}`);
    }
    if (!jsonEqual(actual, MIGRATE_CONFIG_EXPECTED)) {
      return fail(`config.json is not the v2 shape. got ${JSON.stringify(actual)}`);
    }
    return pass("config.json is in the v2 shape");
  },
};
