/**
 * FALLBACK SCENARIOS — a self-contained, offline stand-in for worker D2's `harness/tasks/**` and
 * `harness/drivers/**`, used only while those modules are missing from this worktree (they are
 * owned by D2; D1 must not create them).
 *
 * Everything here is deterministic: same seed ⇒ same transcript. When the real modules land,
 * `../sources.ts` prefers them and this file is dormant.
 *
 * OWNER: worker D1 (temporary).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TaskDef, TaskVerifyResult } from "../../types.ts";

export interface JudgeAnswer {
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
}

export interface FallbackScenario {
  task: TaskDef;
  /** Arm A's canned turn-by-turn tool plan (one call per turn). */
  armAPlan: readonly { name: string; input: unknown }[];
  armAFinalText: string;
  programB: string;
  programC: string;
  judgeAnswers: Record<string, JudgeAnswer>;
}

const FIXTURES = "harness/runner/fallback/fixtures";

async function readText(dir: string, relative: string): Promise<string> {
  return fs.readFile(path.join(dir, relative), "utf8");
}

/* ------------------------------------------------------------------ *
 * 1. fix-typo — a small edit task
 * ------------------------------------------------------------------ */

const fixTypo: FallbackScenario = {
  task: {
    id: "fallback-fix-typo",
    title: "Fix the greeting typo in src/greeting.ts",
    kind: "medium",
    fixture: `${FIXTURES}/fix-typo`,
    prompt:
      "In src/greeting.ts the greeting function has a typo. Fix it so greeting('world') would return 'Hello, world!'. Leave farewell() unchanged.",
    scriptPrompt:
      "Write ONE Code Mode program that reads src/greeting.ts, fixes the typo in the greeting function, writes the file back and returns the new contents.",
    escalationPrompt:
      "Call decide with a `noul` question asking whether your patch is a correct minimal fix; if `escalate` is true, log the reason and stop without writing.",
    async verify(dir: string): Promise<TaskVerifyResult> {
      const text = await readText(dir, "src/greeting.ts");
      const passed = text.includes("Hello, ${name}!") && !text.includes("Helo,") && text.includes("Goodbye,");
      return { passed, detail: passed ? undefined : "src/greeting.ts does not contain the fixed greeting" };
    },
  },
  armAPlan: [
    { name: "read", input: { path: "src/greeting.ts" } },
    { name: "edit", input: { path: "src/greeting.ts", oldString: "Helo,", newString: "Hello," } },
  ],
  armAFinalText: "Fixed the greeting typo in src/greeting.ts.",
  programB: [
    'const text = await tools.read({ path: "src/greeting.ts" });',
    'const fixed = text.replace("Helo,", "Hello,");',
    'await tools.write({ path: "src/greeting.ts", content: fixed });',
    "return fixed;",
  ].join("\n"),
  programC: [
    'const file = "src/greeting.ts";',
    "const text = await tools.read({ path: file });",
    'const fixed = text.replace("Helo,", "Hello,");',
    "const verdict = await tools.typesafe.decide({",
    "  state: { file, before: text, after: fixed },",
    '  questions: { mode: "noul", id: "patch-ok", criterion: "Is this a correct minimal typo fix?", criteria: { true: "correct minimal fix", false: "not a correct fix" } },',
    "  escalateBelow: 0.5,",
    "});",
    "if (verdict.escalate) { console.log(\"escalate:\", verdict.reason); return { escalated: true }; }",
    'await tools.write({ path: file, content: fixed });',
    "return { wrote: true, confidence: verdict.confidence };",
  ].join("\n"),
  judgeAnswers: { "patch-ok": { noul: 0.97, confidence: 0.94 } },
};

/* ------------------------------------------------------------------ *
 * 2. count-todos — a small grep + write task
 * ------------------------------------------------------------------ */

const TODO_COUNT = 3;

const countTodos: FallbackScenario = {
  task: {
    id: "fallback-count-todos",
    title: "Count TODO markers and write the total to answer.txt",
    kind: "one-shot",
    fixture: `${FIXTURES}/count-todos`,
    prompt: `Count every line containing the marker TODO under this directory (docs/ and src/) and write just the number into a new file answer.txt.`,
    scriptPrompt: `Write ONE Code Mode program that counts the lines containing TODO under this directory and writes just the number into answer.txt.`,
    escalationPrompt: `Call decide once with a \`noul\` question asking whether your count is defensible; if \`escalate\` is true, log the reason and stop.`,
    async verify(dir: string): Promise<TaskVerifyResult> {
      const text = (await readText(dir, "answer.txt").catch(() => "")).trim();
      const passed = text === String(TODO_COUNT);
      return { passed, detail: passed ? undefined : `answer.txt is ${JSON.stringify(text)}, expected "${TODO_COUNT}"` };
    },
  },
  armAPlan: [
    { name: "grep", input: { pattern: "TODO", maxResults: 100 } },
    { name: "glob", input: { pattern: "**/*" } },
    { name: "write", input: { path: "answer.txt", content: String(TODO_COUNT) } },
  ],
  armAFinalText: `Counted ${TODO_COUNT} TODO markers and wrote answer.txt.`,
  programB: [
    'const found = await tools.grep({ pattern: "TODO" });',
    "const count = found.matches.length;",
    'await tools.write({ path: "answer.txt", content: String(count) });',
    "return { count };",
  ].join("\n"),
  programC: [
    'const found = await tools.grep({ pattern: "TODO" });',
    "const count = found.matches.length;",
    "const verdict = await tools.typesafe.decide({",
    "  state: { matches: found.matches, count },",
    '  questions: { mode: "noul", id: "count-ok", criterion: "Does the evidence support this TODO count?", criteria: { true: "the count matches the matches found", false: "the count is unsupported" } },',
    "  escalateBelow: 0.5,",
    "});",
    "if (verdict.escalate) { console.log(\"escalate:\", verdict.reason); return { escalated: true }; }",
    'await tools.write({ path: "answer.txt", content: String(count) });',
    "return { count, confidence: verdict.confidence };",
  ].join("\n"),
  judgeAnswers: { "count-ok": { noul: 0.9, confidence: 0.8 } },
};

/* ------------------------------------------------------------------ *
 * 3. long-loop — many files, the case the direct loop is worst at
 * ------------------------------------------------------------------ */

const LONG_LOOP_FILES: Readonly<Record<string, string>> = {
  alpha: "alpha one\n",
  bravo: "bravo two\n",
  charlie: "charlie three\n",
  delta: "delta four\n",
  echo: "echo five\n",
};

const longLoop: FallbackScenario = {
  task: {
    id: "fallback-long-loop",
    title: "Uppercase every data/*.txt into out/<name>.upper.txt",
    kind: "long-loop",
    fixture: `${FIXTURES}/long-loop`,
    prompt:
      "For every file in data/ (*.txt), create out/<name>.upper.txt containing the uppercased contents of the original. One file per source file.",
    scriptPrompt:
      "Write ONE Code Mode program that, for every file in data/, writes out/<name>.upper.txt with the uppercased contents, and returns the list of files it wrote.",
    escalationPrompt:
      "Call decide before writing, with a `noul` question asking whether uppercasing the contents is safe; if `escalate` is true, log the reason and stop.",
    async verify(dir: string): Promise<TaskVerifyResult> {
      for (const [name, content] of Object.entries(LONG_LOOP_FILES)) {
        const expected = content.toUpperCase();
        const actual = await readText(dir, `out/${name}.upper.txt`).catch(() => undefined);
        if (actual === undefined) return { passed: false, detail: `missing out/${name}.upper.txt` };
        if (actual !== expected) return { passed: false, detail: `out/${name}.upper.txt content mismatch` };
      }
      return { passed: true };
    },
  },
  armAPlan: Object.keys(LONG_LOOP_FILES).flatMap((name) => [
    { name: "read", input: { path: `data/${name}.txt` } },
    { name: "write", input: { path: `out/${name}.upper.txt`, content: LONG_LOOP_FILES[name]!.toUpperCase() } },
  ]),
  armAFinalText: "Wrote one out/<name>.upper.txt per data file.",
  programB: [
    'const listing = await tools.glob({ pattern: "data/*.txt" });',
    "const files = listing.files;",
    "const made = [];",
    "for (const file of files) {",
    "  const text = await tools.read({ path: file });",
    '  const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\\.txt$/, "");',
    '  const out = "out/" + stem + ".upper.txt";',
    "  await tools.write({ path: out, content: text.toUpperCase() });",
    "  made.push(out);",
    "}",
    "return { made };",
  ].join("\n"),
  programC: [
    'const listing = await tools.glob({ pattern: "data/*.txt" });',
    "const files = listing.files;",
    "const made = [];",
    "for (const file of files) {",
    "  const text = await tools.read({ path: file });",
    '  const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\\.txt$/, "");',
    '  const out = "out/" + stem + ".upper.txt";',
    "  const verdict = await tools.typesafe.decide({",
    "    state: { file, text },",
    '    questions: { mode: "noul", id: "safe-to-uppercase", criterion: "Is uppercasing this content safe and lossless?", criteria: { true: "plain ASCII, lossless", false: "unsafe or lossy" } },',
    "    escalateBelow: 0.4,",
    "  });",
    "  if (verdict.escalate) { console.log(\"escalate:\", file, verdict.reason); break; }",
    "  await tools.write({ path: out, content: text.toUpperCase() });",
    "  made.push(out);",
    "}",
    "return { made };",
  ].join("\n"),
  judgeAnswers: { "safe-to-uppercase": { noul: 0.95, confidence: 0.9 } },
};

export const FALLBACK_SCENARIOS: readonly FallbackScenario[] = [fixTypo, countTodos, longLoop];

export function scenarioFor(taskId: string): FallbackScenario | undefined {
  return FALLBACK_SCENARIOS.find((scenario) => scenario.task.id === taskId);
}

export const FALLBACK_TASKS: readonly TaskDef[] = FALLBACK_SCENARIOS.map((scenario) => scenario.task);

export function getFallbackTask(id: string): TaskDef | undefined {
  return scenarioFor(id)?.task;
}

export const FALLBACK_JUDGE_ANSWERS: Readonly<Record<string, JudgeAnswer>> = Object.assign(
  {},
  ...FALLBACK_SCENARIOS.map((scenario) => scenario.judgeAnswers),
);
