/**
 * Task: `rename-symbol` (long-loop).
 *
 * Rename the identifier `legacyRate` to `rollingRate` everywhere in `pkg/`, without
 * touching free-text prose (`pkg/notes.mjs`). The fixture has 12 files that mention
 * the identifier, so a real agent must grep + read across the whole package.
 *
 * `setup()` injects an extra module at scratch time so a hardcoded list of the
 * committed files is not sufficient: the rename has to be discovered by searching.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskVerifyResult } from "../types.ts";
import {
  countMatches,
  describeScriptFailure,
  fail,
  fileExists,
  listFiles,
  pass,
  readText,
  runBunScript,
  type TaskWithJudgeAnswers,
} from "./util.ts";

const OLD = "legacyRate";
const NEW = "rollingRate";

const RULES = [
  "Rename the identifier exactly: `legacyRate` becomes `rollingRate`.",
  "Do not rename anything else, and do not touch prose/comment text.",
  "Only files under `pkg/` matter.",
  "When you are done, `bun check.mjs` must still exit 0.",
];

export const renameSymbol: TaskWithJudgeAnswers = {
  id: "rename-symbol",
  title: "Rename a symbol across a small package",
  kind: "long-loop",
  fixture: "harness/fixtures/rename-corpus",
  tools: ["read", "grep", "glob", "edit", "write"],
  /** Offline judge answers for the canned arm-C program (non-escalating: no `escalateBelow`). */
  judgeAnswers: { actionable: { noul: 0.95, confidence: 0.9 } },
  prompt: [
    "You are working in a small JavaScript package under `pkg/`.",
    `Rename the exported function \`${OLD}\` to \`${NEW}\` across the whole package.`,
    "Search the package, read the files that mention it, and update each one.",
    ...RULES,
  ].join("\n"),
  scriptPrompt: [
    "You are working in a small JavaScript package under `pkg/`.",
    `Rename the exported function \`${OLD}\` to \`${NEW}\` across the whole package.`,
    "Write ONE Code Mode program (JavaScript) that does the whole rename in a single script.",
    "The sandbox tools are available as `await tools.<name>({ ... })`, e.g.",
    "`await tools.glob({ pattern: \"pkg/**/*.mjs\" })`,",
    "`await tools.read({ path: \"pkg/node01.mjs\" })`,",
    "`await tools.grep({ pattern: \"legacyRate\", path: \"pkg\" })` and",
    "`await tools.write({ path, content })`.",
    "Discover the files by searching — do not rely on a fixed list.",
    "Return a JSON summary `{ renamed: [paths] }`.",
    ...RULES,
  ].join("\n"),
  async setup(dir: string): Promise<void> {
    // Generated defect: one more module that uses the old identifier and is NOT
    // referenced from pkg/index.mjs, so glob/grep must actually find it.
    writeFileSync(
      join(dir, "pkg", "mod12.mjs"),
      [
        'import { legacyRate } from "./core.mjs";',
        "",
        '// Added at scratch time by TaskDef.setup — discoverable only by searching.',
        'export const legacyRateNote = "a differently-named symbol that must survive";',
        "",
        "export const value12 = legacyRate(12);",
        "",
      ].join("\n"),
      "utf8",
    );
  },
  async verify(dir: string): Promise<TaskVerifyResult> {
    const pkgDir = join(dir, "pkg");
    const files = listFiles(pkgDir, (rel) => rel.endsWith(".mjs"));
    if (files.length === 0) return fail("pkg/ contains no .mjs files in the scratch copy");

    const offenders: string[] = [];
    let newUses = 0;
    for (const rel of files) {
      const text = readText(join(pkgDir, rel));
      if (countMatches(text, /\blegacyRate\b/g) > 0) offenders.push(`pkg/${rel}`);
      newUses += countMatches(text, /\brollingRate\b/g);
    }
    if (offenders.length > 0) {
      return fail(`old identifier still present in: ${offenders.join(", ")}`);
    }
    if (newUses === 0) return fail(`new identifier ${NEW} was not introduced anywhere`);

    if (!fileExists(dir, "check.mjs")) return fail("check.mjs is missing from the scratch copy");
    const res = runBunScript(dir, "check.mjs");
    if (res.code !== 0) {
      return fail(`check.mjs exited ${res.code}: ${describeScriptFailure(res)}`);
    }
    return pass(`renamed across ${files.length} files; check.mjs exited 0`);
  },
};
