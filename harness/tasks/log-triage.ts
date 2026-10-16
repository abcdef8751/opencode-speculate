/**
 * Task: `log-triage` (long-loop, escalation-capable).
 *
 * Ten log files under `logs/`. The model must scan all of them, count `ERROR`
 * lines per `code=Ennn`, and write a single `triage.json`.
 *
 * Long-loop by construction: the answer depends on every file, so an agent must
 * read/grep across the whole corpus. `verify()` recomputes nothing — it compares
 * the artefact against constants derived from the committed fixture.
 */
import { join } from "node:path";
import type { TaskVerifyResult } from "../types.ts";
import { fail, fileExists, jsonEqual, pass, readJson, type TaskWithJudgeAnswers } from "./util.ts";

/** Expected artefact; keep in sync with `harness/fixtures/log-corpus/logs/**`. */
export const LOG_TRIAGE_EXPECTED = {
  filesScanned: 10,
  totalErrors: 42,
  codes: { E100: 14, E104: 17, E204: 5, E401: 6 },
  topCode: "E104",
} as const;

const SHAPE = [
  "Write a single file `triage.json` in the current directory (JSON, no comments) with exactly this shape:",
  '  { "filesScanned": <int>, "totalErrors": <int>, "codes": { "Ennn": <int>, ... }, "topCode": "Ennn" }',
  'Count only lines whose LEVEL field is exactly `ERROR` (a `WARN` line is not an error).',
  "Extract the code from the `code=<CODE>` field on the counted lines.",
  "`filesScanned` is the number of `*.log.txt` files under `logs/`.",
  "`codes` must contain exactly the codes seen on ERROR lines, with their counts.",
  "`topCode` is the code with the highest count (fewer ties: highest count, then lexicographically smallest).",
];

export const logTriage: TaskWithJudgeAnswers = {
  id: "log-triage",
  title: "Triage a small multi-file log corpus",
  kind: "long-loop",
  fixture: "harness/fixtures/log-corpus",
  tools: ["read", "grep", "glob", "write"],
  /**
   * Offline judge answers for the canned arm-C program (the runner reads this duck-typed hook).
   * THIS is the task designed to escalate: `noul: 0.55` => confidence `|2p-1| = 0.1`, and the
   * canned decide call passes `escalateBelow: 0.5`, so `d.escalate` is true and the program's
   * `break` runs.
   */
  judgeAnswers: { actionable: { noul: 0.55, confidence: 0.9 } },
  prompt: [
    "You are working in a small service-log corpus under `logs/`.",
    "Read the logs under `logs/` and produce the error triage artefact described below.",
    ...SHAPE,
  ].join("\n"),
  scriptPrompt: [
    "You are working in a small service-log corpus under `logs/`.",
    "Write ONE Code Mode program (JavaScript) that scans every log file and writes the triage artefact in one shot.",
    "The sandbox tools are available as `await tools.<name>({ ... })`, e.g.",
    "`await tools.glob({ pattern: \"logs/**/*.log.txt\" })`,",
    "`await tools.read({ path })`, `await tools.grep({ pattern, path })` and",
    "`await tools.write({ path: \"triage.json\", content: JSON.stringify(result) })`.",
    "Return the same object you wrote.",
    ...SHAPE,
  ].join("\n"),
  escalationPrompt: [
    "Arm C extra requirement — you must use the `decide` tool inside the program:",
    "  * `const d = await tools.typesafe.decide({ state, questions: { triage: { mode: \"noul\", id: \"triage\", criterion: \"...\", criteria: { true: \"...\", false: \"...\" } } } })`",
    "  * call it at least once while iterating the logs,",
    "  * keep a `done` ledger of what you have processed,",
    "  * and include the escalation handler verbatim in shape: `if (d.escalate) { console.log(\"[escalate]\", d.reason); break }`,",
    "    inside the same loop, so the program stops early when the judge is unsure.",
    "The program must still write the correct `triage.json` for the corpus.",
  ].join("\n"),
  async verify(dir: string): Promise<TaskVerifyResult> {
    if (!fileExists(dir, "triage.json")) return fail("triage.json was not written");
    let actual: unknown;
    try {
      actual = readJson(join(dir, "triage.json"));
    } catch (err) {
      return fail(`triage.json is not valid JSON: ${String(err)}`);
    }
    if (!jsonEqual(actual, LOG_TRIAGE_EXPECTED)) {
      return fail(`triage.json does not match the corpus. got ${JSON.stringify(actual)}`);
    }
    return pass("triage.json matches the corpus");
  },
};
