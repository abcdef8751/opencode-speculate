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
import type { TaskWithJudgeAnswers } from "./util.ts";

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

/* ------------------------------------------------------------------ *
 * Prompt-shape guards
 *
 * The arm-C prompts teach a model how to call `decide`. docs/CONTRACTS.md §1 defines
 * `questions: DecideQuestion | DecideQuestion[]` — the *script-facing* shape. The id-keyed map
 * (`{ triage: { mode, id } }`) is the internal Jev *wire* shape the tool builds and sends;
 * passing it as `questions` makes `mode`/`id` undefined and worker A's validator throws
 * (`decide: question at index 0 needs a non-empty string "id"`). Substring-only assertions are
 * what let that slip through before, so these helpers inspect the literal's SHAPE.
 *
 * §1's "Consumption caution" adds the mirror-image failure: an ARRAY `questions` yields
 * `DecideVerdict[]`, so an example that branches on a single verdict must destructure/index the
 * result first (`const d = verdicts[0]` / `const [d] = await decide(… )`). Reading `.escalate`
 * straight off the array is `undefined` and the handler becomes silently dead code. That is why
 * the consumption rule below is tied to the decide call, not grepped anywhere in the field.
 * ------------------------------------------------------------------ */

export type QuestionsShape = "array" | "single-question" | "id-keyed-map" | "unrecognised";

const PROMPT_FIELDS = ["prompt", "scriptPrompt", "escalationPrompt"] as const;

/**
 * Index just past the bracket matching `text[start]` (`[`, `{` or `(`), skipping string
 * contents. Returns `-1` when `text[start]` is not an opener or nothing matches.
 */
export function balancedEnd(text: string, start: number): number {
  const opener = text[start];
  if (opener !== "[" && opener !== "{" && opener !== "(") return -1;
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Every `questions: <literal>` (or `questions = <literal>`) sample in `text`.
 * The `=` alternative keeps an assignment form visible instead of silently ignored.
 */
export function questionsLiterals(text: string): string[] {
  const found: string[] = [];
  const marker = /questions\s*[:=]\s*/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    found.push(text.slice(start, end));
    marker.lastIndex = end;
  }
  return found;
}

export function classifyQuestionsLiteral(literal: string): QuestionsShape {
  const body = literal.trim();
  if (body.startsWith("[")) return "array";
  // A bare §1 question object starts with `mode`/`id`.
  if (/^\{\s*(mode|id)\s*[,:}\s]/.test(body)) return "single-question";
  // The wire map: `{ <id>: { mode, … } }`.
  if (/^\{\s*[A-Za-z_$][\w$]*\s*:\s*\{/.test(body)) return "id-keyed-map";
  return "unrecognised";
}

/** Every `id: "<value>"` inside a questions literal. */
export function questionIds(literal: string): string[] {
  const out: string[] = [];
  for (const m of literal.matchAll(/\bid\s*:\s*"([^"]*)"/g)) out.push(m[1] ?? "");
  return out;
}

/* ------------------------------------------------------------------ *
 * Consumption rule: an array-form result must be reduced before `.escalate`
 * ------------------------------------------------------------------ */

/** One `tools.typesafe.decide( … )` call site in a prompt field. */
export interface DecideCallSite {
  /** Identifier the result is bound to (`const <name> = …` / `const [<name>] = …`). */
  bound?: string;
  /** The binding destructures: `const [d] = await decide(…)`. */
  destructured: boolean;
  /** The result is indexed inline: `const d = (await decide(…))[0]` / `.at(0)`. */
  inlineExtracted: boolean;
  /** This call's `questions:` literal, when it has one. */
  questions?: string;
}

/** Text between the last statement boundary before `index` and `index` (bounded). */
function statementHead(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 300), index);
  // Deliberately NOT cut at single newlines: `const verdicts =\n await decide(` is one statement.
  const cut = Math.max(
    window.lastIndexOf(";"),
    window.lastIndexOf("{"),
    window.lastIndexOf("}"),
    window.lastIndexOf("\n\n"),
  );
  return window.slice(cut + 1);
}

/** Every `tools.typesafe.decide( … )` call in `text`, with how its result is bound. */
export function decideCallSites(text: string): DecideCallSite[] {
  const sites: DecideCallSite[] = [];
  const marker = /tools\.typesafe\.decide\s*/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const open = text.indexOf("(", marker.lastIndex);
    if (open === -1) break;
    const end = balancedEnd(text, open);
    if (end === -1) break;

    const head = statementHead(text, match.index);
    const destructured =
      /(?:const|let|var)\s+\[\s*([A-Za-z_$][\w$]*)[^\]]*\]\s*=\s*\(?\s*(?:await\s+)?$/.exec(head);
    const plain = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(?:await\s+)?$/.exec(head);
    const bound =
      destructured !== null ? destructured[1] : plain !== null ? plain[1] : undefined;
    // `const d = (await decide( … ))[0]` / `.at(0)` — extraction applied to the call itself.
    const inlineExtracted = /^\s*\)*\s*(?:\[|\.at\s*\()/.test(text.slice(end, end + 24));

    const questions = questionsLiterals(text.slice(open + 1, end - 1))[0];
    sites.push({
      ...(bound === undefined ? {} : { bound }),
      destructured: destructured !== null,
      inlineExtracted,
      ...(questions === undefined ? {} : { questions }),
    });
    marker.lastIndex = end;
  }
  return sites;
}

/** `name` is reduced from the array `bound` to a single verdict. */
function extractedFrom(text: string, bound: string, name: string): boolean {
  const index = new RegExp(`\\b${name}\\b\\s*=\\s*\\(?\\s*${bound}\\s*(?:\\[|\\.at\\s*\\()`);
  if (index.test(text)) return true;
  return new RegExp(`\\[\\s*${name}\\s*(?:,[^\\]]*)?\\]\\s*=\\s*${bound}\\b`).test(text);
}

/**
 * Names the identifier that consumes an ARRAY-form `decide` result directly as a single verdict
 * (i.e. `<name>.escalate` where `<name>` is the array or is never reduced from it), or
 * `undefined` when the prompt is fine / the rule does not apply.
 *
 * Tied to the decide call: a stray `[0]` elsewhere in the field cannot satisfy it.
 */
export function arrayConsumedAsSingleVerdict(text: string): string | undefined {
  const arraySites = decideCallSites(text).filter(
    (site) => site.questions !== undefined && classifyQuestionsLiteral(site.questions) === "array",
  );
  if (arraySites.length === 0) return undefined;
  const consumed = /\b([A-Za-z_$][\w$]*)\.escalate\b/.exec(text);
  if (consumed === null) return undefined;
  const name = consumed[1] ?? "";
  const derived = arraySites.some(
    (site) =>
      (site.destructured && site.bound === name) ||
      (site.inlineExtracted && site.bound === name) ||
      (site.bound !== undefined && extractedFrom(text, site.bound, name)),
  );
  return derived ? undefined : name;
}

interface PromptSample {
  taskId: string;
  field: string;
  literal: string;
  shape: QuestionsShape;
}

function promptSamples(): PromptSample[] {
  const out: PromptSample[] = [];
  for (const task of TASKS) {
    for (const field of PROMPT_FIELDS) {
      const text = task[field];
      if (typeof text !== "string") continue;
      for (const literal of questionsLiterals(text)) {
        out.push({ taskId: task.id, field, literal, shape: classifyQuestionsLiteral(literal) });
      }
    }
  }
  return out;
}

describe("prompt-shape guard (self-test)", () => {
  test("classifies the §1 script forms and rejects the Jev wire map", () => {
    expect(
      classifyQuestionsLiteral('[ { mode: "noul", id: "x", criteria: { true: "y", false: "n" } } ]'),
    ).toBe("array");
    expect(
      classifyQuestionsLiteral('{ mode: "noul", id: "x", criteria: { true: "y", false: "n" } }'),
    ).toBe("single-question");
    expect(classifyQuestionsLiteral('{ mode, id, criteria: { true: "y", false: "n" } }')).toBe(
      "single-question",
    );
    expect(classifyQuestionsLiteral('{ id: "x", mode: "noul" }')).toBe("single-question");
    expect(classifyQuestionsLiteral('{ triage: { mode: "noul", id: "triage" } }')).toBe("id-keyed-map");
    expect(classifyQuestionsLiteral('{ audit: { mode: "noul", id: "audit" } }')).toBe("id-keyed-map");
    // "…" is the hint's elided placeholder: fail closed rather than guess.
    expect(classifyQuestionsLiteral("{ … }")).toBe("unrecognised");
  });

  test("extracts a balanced literal and is not fooled by brackets inside strings", () => {
    const text =
      'questions: [{ mode: "noul", id: "q", criteria: { true: "}", false: "{" } }], escalateBelow: 0.5';
    const found = questionsLiterals(text);
    expect(found.length).toBe(1);
    expect(classifyQuestionsLiteral(found[0] as string)).toBe("array");
    expect(found[0]).toContain('true: "}"');
    expect(found[0]).not.toContain("escalateBelow");
  });

  test("reads the question ids out of a literal", () => {
    expect(questionIds('{ mode: "noul", id: "triage", criterion: "..." }')).toEqual(["triage"]);
    expect(questionIds('{ mode: "noul", criteria: { true: "a", false: "b" } }')).toEqual([]);
  });

  test("also sees an assignment form (`questions = …`), not just `questions:`", () => {
    expect(questionsLiterals('questions = [{ mode: "noul", id: "x" }]').length).toBe(1);
  });

  test("the consumption rule REJECTS an array result consumed as a single verdict", () => {
    // The exact shape review pass 2 caught in the hint: array in, `.escalate` straight off it.
    const broken = [
      'const d = await tools.typesafe.decide({ state: out, questions: [{ mode: "noul", id: "goal-met?", criteria: { true: "…", false: "…" } }], escalateBelow: 0.6 });',
      "if (d.escalate) { console.log(d.reason); }",
    ].join("\n");
    expect(arrayConsumedAsSingleVerdict(broken)).toBe("d");

    // ...and a stray `[0]` elsewhere in the field must NOT rescue it.
    const brokenWithDecoy = [
      "// see item [0] of the ledger for context",
      "const d = await tools.typesafe.decide({ state, questions: [{ mode: \"noul\", id: \"x\" }] });",
      "if (d.escalate) { console.log(d.reason); }",
    ].join("\n");
    expect(arrayConsumedAsSingleVerdict(brokenWithDecoy)).toBe("d");
  });

  test("the consumption rule ACCEPTS every valid way to obtain one verdict", () => {
    const q = '[{ mode: "noul", id: "x", criteria: { true: "y", false: "n" } }]';
    const accepted = [
      // destructure the call
      `const [d] = await tools.typesafe.decide({ state, questions: ${q} });\nif (d.escalate) { console.log(d.reason); }`,
      // index the call inline
      `const d = (await tools.typesafe.decide({ state, questions: ${q} }))[0];\nif (d.escalate) { console.log(d.reason); }`,
      // index a bound result
      `const verdicts = await tools.typesafe.decide({ state, questions: ${q} });\nconst d = verdicts[0];\nif (d.escalate) { console.log(d.reason); }`,
      // `.at(0)` a bound result
      `const verdicts = await tools.typesafe.decide({ state, questions: ${q} });\nconst d = verdicts.at(0);\nif (d.escalate) { console.log(d.reason); }`,
      // destructure a bound result
      `const verdicts = await tools.typesafe.decide({ state, questions: ${q} });\nconst [d] = verdicts;\nif (d.escalate) { console.log(d.reason); }`,
      // formatting variants: newline before `await`, spaced index, no semicolons
      `const verdicts =\n  await tools.typesafe.decide({\n    state,\n    questions: ${q},\n  })\nconst d = verdicts[ 0 ]\nif (d.escalate) { console.log(d.reason) }`,
      // single-question form: rule does not apply
      `const d = await tools.typesafe.decide({ state, questions: { mode: "noul", id: "x" } });\nif (d.escalate) { console.log(d.reason); }`,
    ];
    for (const form of accepted) {
      expect(arrayConsumedAsSingleVerdict(form)).toBeUndefined();
    }
  });
});

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

  test("no prompt teaches the Jev id-keyed wire map as `questions`", () => {
    const samples = promptSamples();
    // Fail closed if the extractor stops finding anything: a silent skip would hide the defect.
    expect(samples.length).toBeGreaterThanOrEqual(2);
    const offenders = samples
      .filter((sample) => sample.shape === "id-keyed-map" || sample.shape === "unrecognised")
      .map((sample) => `${sample.taskId}.${sample.field} (${sample.shape}): ${sample.literal.slice(0, 90)}`);
    expect(offenders).toEqual([]);
  });

  test("every prompt `questions` sample is the §1 script-facing shape", () => {
    const samples = promptSamples();
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of samples) {
      expect(`${sample.taskId}.${sample.field}:${sample.shape}`).toMatch(
        /:(array|single-question)$/,
      );
    }
  });

  test("an array-form example consumed as a single verdict must show the extraction", () => {
    // §1 "Consumption caution": an array `questions` yields `DecideVerdict[]`, so a prompt that
    // branches on `d.escalate` must show how `d` is reduced from the call's result. The check is
    // tied to the decide call — a stray `[0]` elsewhere in the field cannot satisfy it.
    let checked = 0;
    for (const task of TASKS) {
      for (const field of PROMPT_FIELDS) {
        const text = task[field];
        if (typeof text !== "string") continue;
        const hasArray = decideCallSites(text).some(
          (site) => site.questions !== undefined && classifyQuestionsLiteral(site.questions) === "array",
        );
        if (!hasArray || !/\b[A-Za-z_$][\w$]*\.escalate\b/.test(text)) continue;
        checked += 1;
        const offender = arrayConsumedAsSingleVerdict(text);
        expect(`${task.id}.${field}:${offender ?? "ok"}`).toBe(`${task.id}.${field}:ok`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  test("every question id a prompt teaches is scripted for the offline judge", () => {
    // The fake judge throws on unscripted ids, so a live model following its prompt must still
    // find an answer. Generous but not vacuous: it must actually see the taught ids.
    let seen = 0;
    const missing: string[] = [];
    for (const task of TASKS) {
      const answers = (task as TaskWithJudgeAnswers).judgeAnswers ?? {};
      for (const field of PROMPT_FIELDS) {
        const text = task[field];
        if (typeof text !== "string") continue;
        for (const literal of questionsLiterals(text)) {
          for (const id of questionIds(literal)) {
            seen += 1;
            if (answers[id] === undefined) {
              missing.push(`${task.id}.${field}: "${id}" has no judgeAnswers entry`);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(missing).toEqual([]);
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

  test("every task carries offline judgeAnswers for its arm-C decide call", () => {
    // Duck-typed hook read by D1's orchestrator; the fake judge throws on unscripted ids.
    for (const task of TASKS) {
      const answers = (task as TaskWithJudgeAnswers).judgeAnswers;
      expect(`${task.id}:${answers === undefined ? "missing" : "present"}`).toBe(`${task.id}:present`);
      const ids = Object.keys(answers ?? {});
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id.length).toBeGreaterThan(0);
        expect(typeof answers?.[id]?.noul).toBe("number");
      }
    }
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
