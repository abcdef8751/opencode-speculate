/**
 * Task: `deprecated-audit` (long-loop, escalation-capable).
 *
 * Fourteen small modules under `src/`. The model must read all of them and write
 * a precise audit: which files carry the `@deprecated` tag, and how many `TODO`
 * tokens each file has. Deliberate traps: a `@Deprecated` (capitalised) tag, and
 * the plural word `TODOS` (which must not count as a `TODO` token).
 */
import { join } from "node:path";
import type { TaskVerifyResult } from "../types.ts";
import { fail, fileExists, jsonEqual, pass, readJson, type TaskWithJudgeAnswers } from "./util.ts";

/** Expected artefact; keep in sync with `harness/fixtures/service-tree/src/**`. */
export const DEPRECATED_AUDIT_EXPECTED = {
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
} as const;

const SHAPE = [
  "Write a single file `audit.json` in the current directory (JSON, no comments) with exactly this shape:",
  '  { "deprecated": ["src/x.mjs", ...], "deprecatedCount": <int>, "todoCounts": { "src/x.mjs": <int> }, "topTodo": "src/x.mjs" }',
  "Consider only the `.mjs` files that sit directly under `src/`.",
  '`deprecated` lists, sorted lexicographically, the files containing the literal tag `@deprecated`',
  "  (the tag match is case-sensitive: `@Deprecated` does not count).",
  "`todoCounts` maps every file that contains the token `TODO` to its occurrence count.",
  "  `TODO` must be matched as a whole word: `TODOS` does not count.",
  "`topTodo` is the file with the highest count (ties: lexicographically smallest).",
];

export const deprecatedAudit: TaskWithJudgeAnswers = {
  id: "deprecated-audit",
  title: "Audit deprecated modules and TODO markers",
  kind: "long-loop",
  fixture: "harness/fixtures/service-tree",
  tools: ["read", "grep", "glob", "write"],
  /**
   * Offline judge answers for the arm-C `decide` call. `actionable` is the id the canned mock
   * program sends; `audit` is the id the arm-C prompt teaches.
   *
   * This task is designed NOT to escalate, by two independent mechanisms: the canned program
   * passes no `escalateBelow` (§1: with no threshold anywhere, escalation is opt-in and never
   * fires), and both scripted answers are high-confidence (`noul: 0.95` => `|2p-1| = 0.9`).
   * The prompt example does show `escalateBelow: 0.5`, but 0.9 > 0.5, so a live model following
   * the prompt would not escalate either.
   */
  judgeAnswers: {
    actionable: { noul: 0.95, confidence: 0.9 },
    audit: { noul: 0.95, confidence: 0.9 },
  },
  prompt: [
    "You are working in a tree of small service modules under `src/`.",
    "Inspect every module and produce the audit artefact described below.",
    ...SHAPE,
  ].join("\n"),
  scriptPrompt: [
    "You are working in a tree of small service modules under `src/`.",
    "Write ONE Code Mode program (JavaScript) that reads every module and writes the audit artefact in one shot.",
    "The sandbox tools are available as `await tools.<name>({ ... })`, e.g.",
    "`await tools.glob({ pattern: \"src/*.mjs\" })`, `await tools.read({ path })`,",
    "`await tools.grep({ pattern: \"@deprecated\", path: \"src\" })` and",
    "`await tools.write({ path: \"audit.json\", content: JSON.stringify(result) })`.",
    "Return the same object you wrote.",
    ...SHAPE,
  ].join("\n"),
  escalationPrompt: [
    "Arm C extra requirement — you must use the `decide` tool inside the program:",
    "  * `const verdicts = await tools.typesafe.decide({ state, questions: [{ mode: \"noul\", id: \"audit\", criterion: \"...\", criteria: { true: \"...\", false: \"...\" } }], escalateBelow: 0.5 })`",
    "    `questions` is an ARRAY of question objects (the §1 script-facing shape); one question in gives an array holding one verdict back.",
    "  * `const d = verdicts[0];` — the single verdict the handler below inspects.",
    "  * call it at least once while iterating the files,",
    "  * keep a `done` ledger of what you have processed,",
    "  * and include the escalation handler verbatim in shape: `if (d.escalate) { console.log(\"[escalate]\", d.reason); break }`,",
    "    inside the same loop, so the program stops early when the judge is unsure.",
    "The program must still write the correct `audit.json` for the tree.",
  ].join("\n"),
  async verify(dir: string): Promise<TaskVerifyResult> {
    if (!fileExists(dir, "audit.json")) return fail("audit.json was not written");
    let actual: unknown;
    try {
      actual = readJson(join(dir, "audit.json"));
    } catch (err) {
      return fail(`audit.json is not valid JSON: ${String(err)}`);
    }
    if (!jsonEqual(actual, DEPRECATED_AUDIT_EXPECTED)) {
      return fail(`audit.json does not match the tree. got ${JSON.stringify(actual)}`);
    }
    return pass("audit.json matches the tree");
  },
};
