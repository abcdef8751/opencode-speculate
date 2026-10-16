/**
 * Deterministic, network-free `ModelDriver`.
 *
 * WHAT THIS IS
 *   A mock, and *only* a mock. It exists so the harness can run end-to-end offline and
 *   reproducibly. Every tool call and every token figure it produces is SYNTHETIC — it is
 *   NOT a measurement of any real model. The report must label these numbers as synthetic.
 *
 * REPRODUCIBILITY
 *   `complete()` is a pure function of (options, transcript, tool list): the same `seed`
 *   plus the same transcript always yields byte-identical output. It never touches the
 *   network and never reads the filesystem.
 *
 * ARM DETECTION
 *   The arms pass different tool lists and different prompts, so the driver looks at both:
 *     1. a `decide` / `typesafe*` tool in the list, or `tools.typesafe.decide` in the prompt => C
 *     2. an `execute`-style tool in the list, or the words "Code Mode program" in the prompt => B
 *     3. otherwise => A
 *
 * TASK DETECTION
 *   The canned response is keyed by task id. The driver finds the task id by looking for the
 *   keys it knows about (from `programs` and the built-in defaults) as substrings of the
 *   transcript, preferring the longest match. If nothing matches, a generic canned program is
 *   used. This works whether the runner puts the task id in a system message or only in the
 *   task prompt (the task prompt always embeds the id via its wording? no — it embeds the
 *   prompt, and the prompt is unique per task; the runner is expected to include the id).
 *
 * TOOL-INPUT ASSUMPTIONS (canned programs / scripted arm-A calls)
 *   `read({ path })`, `glob({ pattern })`, `grep({ pattern, path })`, `write({ path, content })`,
 *   `shell({ command })`. Output is read leniently (string, or `{content|text}`, `{files|matches|paths}`).
 *   If worker D1's sandbox uses different inputs, callers can override any arm via `programs`.
 */
import type {
  ArmID,
  ChatMessage,
  Json,
  ModelDriver,
  ModelResponse,
  TokenUsage,
  ToolDescriptor,
} from "../types.ts";

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface MockDriverOptions {
  /** Seed for the synthetic token jitter. Same seed => identical output. Default `1`. */
  seed?: number;
  /**
   * Per-task overrides. For arms `B`/`C` the string replaces the canned Code Mode program.
   * For arm `A` the string replaces the final assistant text (the scripted tool-call sequence
   * is unchanged). Keyed by task id.
   */
  programs?: Record<string, { A?: string; B?: string; C?: string }>;
  /** Synthetic token accounting model. Default `"cached-heavy"`. */
  usageModel?: "small" | "cached-heavy";
}

/* ------------------------------------------------------------------ *
 * Deterministic PRNG + synthetic usage
 * ------------------------------------------------------------------ */

/** mulberry32 — tiny, seeded, deterministic. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rng: () => number, base: number, pct: number): number {
  return Math.max(0, Math.round(base * (1 + (rng() * 2 - 1) * pct)));
}

/**
 * SYNTHETIC token accounting. Not a measurement.
 *
 * `"cached-heavy"` mimics a long agent session: the context is re-sent every turn and the
 * provider serves most of it from cache, so `cacheRead` grows with the turn index and
 * dominates the input side. `"small"` is a flat, low-cache session.
 *
 * `costUsd` is deliberately left undefined: this driver will not invent a price.
 */
export function synthesizeUsage(
  seed: number,
  step: number,
  model: "small" | "cached-heavy",
): TokenUsage {
  const rng = mulberry32((seed ^ Math.imul(step + 1, 0x9e3779b9)) >>> 0);
  if (model === "cached-heavy") {
    return {
      fresh: jitter(rng, 120, 0.2),
      cacheWrite: step === 0 ? jitter(rng, 900, 0.2) : 0,
      cacheRead: jitter(rng, (step + 1) * 3000, 0.1),
      output: jitter(rng, 200, 0.3),
    };
  }
  return {
    fresh: jitter(rng, 900, 0.15),
    cacheWrite: 0,
    cacheRead: jitter(rng, 200, 0.3),
    output: jitter(rng, 160, 0.25),
  };
}

/* ------------------------------------------------------------------ *
 * Canned artifacts (arm A writes these so the offline run is meaningful)
 * ------------------------------------------------------------------ */

const line = (...parts: string[]): string => parts.join("\n");

/** Corrected `src/stats.mjs` (keep in sync with harness/fixtures/buggy-stats). */
const FIXED_STATS_MJS = line(
  "// Small statistics helpers used by the fixture's check script.",
  "",
  "export function mean(values) {",
  "  if (values.length === 0) return 0;",
  "  let total = 0;",
  "  for (const v of values) total += v;",
  "  return total / values.length;",
  "}",
  "",
  "export function median(values) {",
  "  if (values.length === 0) return 0;",
  "  const sorted = [...values].sort((a, b) => a - b);",
  "  const mid = Math.floor(sorted.length / 2);",
  "  if (sorted.length % 2 === 1) return sorted[mid];",
  "  return (sorted[mid - 1] + sorted[mid]) / 2;",
  "}",
  "",
);

/** v2-shaped `config.json` (keep in sync with harness/fixtures/config-migrate). */
const CONFIG_V2_JSON = line(
  "{",
  '  "logging": {',
  '    "level": "debug"',
  "  },",
  '  "network": {',
  '    "retries": 3,',
  '    "timeoutMs": 1500',
  "  },",
  '  "features": ["cache", "metrics"]',
  "}",
  "",
);

/** Expected `triage.json` (keep in sync with harness/fixtures/log-corpus). */
const TRIAGE_JSON = line(
  "{",
  '  "filesScanned": 10,',
  '  "totalErrors": 42,',
  '  "codes": {',
  '    "E100": 14,',
  '    "E104": 17,',
  '    "E204": 5,',
  '    "E401": 6',
  "  },",
  '  "topCode": "E104"',
  "}",
  "",
);

/** Expected `audit.json` (keep in sync with harness/fixtures/service-tree). */
const AUDIT_JSON = line(
  "{",
  '  "deprecated": ["src/cache.mjs", "src/db.mjs", "src/logger.mjs", "src/queue.mjs", "src/session.mjs"],',
  '  "deprecatedCount": 5,',
  '  "todoCounts": {',
  '    "src/auth.mjs": 1,',
  '    "src/cache.mjs": 2,',
  '    "src/db.mjs": 1,',
  '    "src/http.mjs": 3,',
  '    "src/logger.mjs": 1,',
  '    "src/search.mjs": 2',
  "  },",
  '  "topTodo": "src/http.mjs"',
  "}",
  "",
);

const RENAMED_CORE_MJS = line(
  "/** Doubles a value and adds one. Used across every module in this package. */",
  "export function rollingRate(value) {",
  "  return value * 2 + 1;",
  "}",
  "",
);

const renamedNodeMjs = (n: number): string => {
  const nn = String(n).padStart(2, "0");
  return line(
    'import { rollingRate } from "./core.mjs";',
    "",
    `export const value${nn} = rollingRate(${n});`,
    "",
  );
};

const RENAMED_INDEX_MJS = line(
  'import { rollingRate } from "./core.mjs";',
  'import { value01 } from "./node01.mjs";',
  'import { value02 } from "./node02.mjs";',
  'import { value03 } from "./node03.mjs";',
  'import { value04 } from "./node04.mjs";',
  'import { value05 } from "./node05.mjs";',
  'import { value06 } from "./node06.mjs";',
  'import { value07 } from "./node07.mjs";',
  'import { value08 } from "./node08.mjs";',
  'import { value09 } from "./node09.mjs";',
  'import { value10 } from "./node10.mjs";',
  "",
  "export const total =",
  "  value01 + value02 + value03 + value04 + value05 +",
  "  value06 + value07 + value08 + value09 + value10;",
  "",
  "export function describe() {",
  "  return `package total=${total}`;",
  "}",
  "",
  "export { rollingRate };",
  "",
);

const RENAMED_MOD12_MJS = line(
  'import { rollingRate } from "./core.mjs";',
  "",
  "// Added at scratch time by TaskDef.setup — discoverable only by searching.",
  'export const legacyRateNote = "a differently-named symbol that must survive";',
  "",
  "export const value12 = rollingRate(12);",
  "",
);

/**
 * Files arm A writes for each task (path relative to the scratch dir -> full content).
 * Exported so tests can prove that applying these makes `TaskDef.verify` pass — that keeps
 * the canned mock honest about the fixtures instead of silently drifting from them.
 */
export const MOCK_ARM_A_WRITES: Record<string, Record<string, string>> = {
  "fix-median": { "src/stats.mjs": FIXED_STATS_MJS },
  "migrate-config": { "config.json": CONFIG_V2_JSON },
  "log-triage": { "triage.json": TRIAGE_JSON },
  "deprecated-audit": { "audit.json": AUDIT_JSON },
  "rename-symbol": {
    "pkg/core.mjs": RENAMED_CORE_MJS,
    "pkg/node01.mjs": renamedNodeMjs(1),
    "pkg/node02.mjs": renamedNodeMjs(2),
    "pkg/node03.mjs": renamedNodeMjs(3),
    "pkg/node04.mjs": renamedNodeMjs(4),
    "pkg/node05.mjs": renamedNodeMjs(5),
    "pkg/node06.mjs": renamedNodeMjs(6),
    "pkg/node07.mjs": renamedNodeMjs(7),
    "pkg/node08.mjs": renamedNodeMjs(8),
    "pkg/node09.mjs": renamedNodeMjs(9),
    "pkg/node10.mjs": renamedNodeMjs(10),
    "pkg/index.mjs": RENAMED_INDEX_MJS,
    "pkg/mod12.mjs": RENAMED_MOD12_MJS,
  },
};

/* ------------------------------------------------------------------ *
 * Arm A: scripted tool-call sequences
 * ------------------------------------------------------------------ */

interface MockToolCall {
  name: string;
  input: Json;
}

const writeCalls = (taskId: string): MockToolCall[] =>
  Object.entries(MOCK_ARM_A_WRITES[taskId] ?? {}).map(([path, content]) => ({
    name: "write",
    input: { path, content },
  }));

const ARM_A_SEQUENCES: Record<string, { calls: MockToolCall[]; final: string }> = {
  "fix-median": {
    calls: [
      { name: "glob", input: { pattern: "**/*.mjs" } },
      { name: "read", input: { path: "src/stats.mjs" } },
      { name: "grep", input: { pattern: "length - 1", path: "src" } },
      ...writeCalls("fix-median"),
      { name: "shell", input: { command: "bun check.mjs" } },
    ],
    final: "Fixed the divisor in src/stats.mjs (it divided by length - 1). `bun check.mjs` passes.",
  },
  "migrate-config": {
    calls: [
      { name: "read", input: { path: "README.md" } },
      { name: "read", input: { path: "config.schema.md" } },
      { name: "read", input: { path: "config.json" } },
      ...writeCalls("migrate-config"),
    ],
    final: "Rewrote config.json into the v2 { logging, network, features } shape.",
  },
  "rename-symbol": {
    calls: [
      { name: "glob", input: { pattern: "pkg/**/*.mjs" } },
      { name: "grep", input: { pattern: "legacyRate", path: "pkg" } },
      { name: "read", input: { path: "pkg/core.mjs" } },
      { name: "read", input: { path: "pkg/index.mjs" } },
      { name: "read", input: { path: "pkg/notes.mjs" } },
      ...writeCalls("rename-symbol"),
    ],
    final: "Renamed legacyRate to rollingRate across pkg/ (prose left untouched).",
  },
  "log-triage": {
    calls: [
      { name: "glob", input: { pattern: "logs/**/*.log.txt" } },
      { name: "grep", input: { pattern: " ERROR ", path: "logs" } },
      { name: "grep", input: { pattern: "code=", path: "logs" } },
      ...writeCalls("log-triage"),
    ],
    final: "Wrote triage.json: 42 ERROR lines across 10 files, top code E104 (17).",
  },
  "deprecated-audit": {
    calls: [
      { name: "glob", input: { pattern: "src/*.mjs" } },
      { name: "grep", input: { pattern: "@deprecated", path: "src" } },
      { name: "grep", input: { pattern: "TODO", path: "src" } },
      ...writeCalls("deprecated-audit"),
    ],
    final: "Wrote audit.json: 5 deprecated modules, src/http.mjs has the most TODOs (3).",
  },
};

const GENERIC_ARM_A: { calls: MockToolCall[]; final: string } = {
  calls: [
    { name: "glob", input: { pattern: "**/*" } },
    { name: "grep", input: { pattern: "TODO", path: "." } },
  ],
  final: "Mock driver: inspected the project and stopped.",
};

/* ------------------------------------------------------------------ *
 * Arms B/C: canned Code Mode programs
 * ------------------------------------------------------------------ */

/** Lenient helpers prepended to every canned program (see the assumptions in the header). */
const PROGRAM_PRELUDE = [
  "const readText = async (path) => {",
  '  const r = await tools.read({ path });',
  '  return typeof r === "string" ? r : (r && (r.content ?? r.text)) || "";',
  "};",
  "const writeText = async (path, content) => tools.write({ path, content });",
  "const globPaths = async (pattern) => {",
  '  const r = await tools.glob({ pattern });',
  '  const arr = Array.isArray(r) ? r : (r && (r.files ?? r.matches ?? r.paths)) || [];',
  '  return arr.map((f) => (typeof f === "string" ? f : (f && (f.path ?? f.file ?? f.name)) || "")).filter(Boolean);',
  "};",
];

const programFixMedian = [
  "const stats = await readText(\"src/stats.mjs\");",
  "const fixed = stats.replace(\"values.length - 1\", \"values.length\");",
  "await writeText(\"src/stats.mjs\", fixed);",
  "return { ok: true, changed: fixed !== stats };",
];

const programMigrateConfig = [
  'const v1 = JSON.parse(await readText("config.json"));',
  "const next = {",
  "  logging: { level: v1.logLevel },",
  "  network: { retries: v1.retries, timeoutMs: v1.timeoutMs },",
  "  features: v1.features,",
  "};",
  'await writeText("config.json", JSON.stringify(next, null, 2));',
  "return next;",
];

const programRenameSymbol = [
  'const paths = await globPaths("pkg/**/*.mjs");',
  "const renamed = [];",
  "for (const p of paths) {",
  "  const text = await readText(p);",
  "  if (!/\\blegacyRate\\b/.test(text)) continue;",
  '  const next = text.replace(/\\blegacyRate\\b/g, "rollingRate");',
  "  if (next !== text) { await writeText(p, next); renamed.push(p); }",
  "}",
  "return { renamed };",
];

const programLogTriage = [
  'const paths = await globPaths("logs/**/*.log.txt");',
  "const codes = {};",
  "let totalErrors = 0;",
  "for (const p of paths) {",
  "  const text = await readText(p);",
  '  for (const rawLine of text.split("\\n")) {',
  '    if (!rawLine.includes(" ERROR ")) continue;',
  "    totalErrors++;",
  "    const m = rawLine.match(/code=(E\\d+)/);",
  "    if (m) codes[m[1]] = (codes[m[1]] || 0) + 1;",
  "  }",
  "}",
  "const topCode = Object.keys(codes).sort((a, b) => (codes[b] - codes[a]) || (a < b ? -1 : 1))[0] || \"\";",
  "const result = { filesScanned: paths.length, totalErrors, codes, topCode };",
  'await writeText("triage.json", JSON.stringify(result, null, 2));',
  "return result;",
];

const programDeprecatedAudit = [
  'const paths = await globPaths("src/*.mjs");',
  "const deprecated = [];",
  "const todoCounts = {};",
  "for (const p of paths) {",
  "  const text = await readText(p);",
  '  if (text.includes("@deprecated")) deprecated.push(p);',
  "  const n = (text.match(/\\bTODO\\b/g) || []).length;",
  "  if (n > 0) todoCounts[p] = n;",
  "}",
  "deprecated.sort();",
  "const topTodo = Object.keys(todoCounts).sort((a, b) => (todoCounts[b] - todoCounts[a]) || (a < b ? -1 : 1))[0] || \"\";",
  "const result = { deprecated, deprecatedCount: deprecated.length, todoCounts, topTodo };",
  'await writeText("audit.json", JSON.stringify(result, null, 2));',
  "return result;",
];

const GENERIC_PROGRAM = [
  'const paths = await globPaths("**/*");',
  'console.log("mock: discovered", paths.length, "paths");',
  "return { ok: true, discovered: paths.length };",
];

/** The `decide` + `break` handler demanded by the arm-C prompt, in the plan's shape. */
const decideLoop = (stateExpr: string, iterable: string): string[] => [
  "const done = [];",
  `for (const item of ${iterable}) {`,
  "  const d = await tools.typesafe.decide({",
  `    state: ${stateExpr},`,
  "    questions: { actionable: { mode: \"noul\", id: \"actionable\", criterion: \"Is this item safe to finalize?\", criteria: { true: \"yes\", false: \"no\" } } },",
  "  });",
  "  done.push(item);",
  '  if (d.escalate) { console.log("[escalate]", d.reason, item); break }',
  "}",
  'console.log("[decide] checked", done.length, "items");',
];

const buildProgram = (
  body: string[],
  c: boolean,
  loopIterable: string,
  stateExpr: string,
): string => {
  const lines = [
    "// SYNTHETIC canned Code Mode program (mock driver).",
    ...PROGRAM_PRELUDE,
    "",
    ...body,
  ];
  if (c) {
    // Insert the decide loop *before* the program's own final `return`, otherwise it is
    // dead code.
    const lastReturn = lines.reduce((acc, l, i) => (l.startsWith("return") ? i : acc), -1);
    const loop = decideLoop(stateExpr, loopIterable);
    if (lastReturn >= 0) lines.splice(lastReturn, 0, "", ...loop, "");
    else lines.push("", ...loop);
  }
  return lines.join("\n");
};

export const MOCK_PROGRAMS: Record<string, { B: string; C: string }> = {
  "fix-median": {
    B: buildProgram(programFixMedian, false, "[]", "null"),
    C: buildProgram(programFixMedian, true, '["src/stats.mjs"]', '({ file: item })'),
  },
  "migrate-config": {
    B: buildProgram(programMigrateConfig, false, "[]", "null"),
    C: buildProgram(programMigrateConfig, true, '["config.json"]', '({ file: item })'),
  },
  "rename-symbol": {
    B: buildProgram(programRenameSymbol, false, "[]", "null"),
    C: buildProgram(programRenameSymbol, true, '["pkg/core.mjs"]', '({ file: item })'),
  },
  "log-triage": {
    B: buildProgram(programLogTriage, false, "[]", "null"),
    C: buildProgram(programLogTriage, true, '["logs/2026-10-01.api.log.txt"]', '({ file: item, codes })'),
  },
  "deprecated-audit": {
    B: buildProgram(programDeprecatedAudit, false, "[]", "null"),
    C: buildProgram(programDeprecatedAudit, true, '["src/http.mjs"]', '({ file: item })'),
  },
};

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

const isDecideTool = (name: string): boolean =>
  name === "decide" || name === "typesafe" || name.endsWith(".decide") || name.startsWith("typesafe.");

const isExecuteTool = (name: string): boolean =>
  name === "execute" || name === "search" || name.startsWith("codemode") || name.endsWith(".execute");

const executeToolName = (tools: readonly ToolDescriptor[]): string | undefined =>
  tools.find((t) => t.name === "execute" || t.name.endsWith(".execute"))?.name;

export function detectArm(
  tools: readonly ToolDescriptor[],
  transcriptText: string,
): ArmID {
  const names = tools.map((t) => t.name);
  if (names.some(isDecideTool) || /tools\.typesafe\.decide/.test(transcriptText)) return "C";
  if (names.some(isExecuteTool) || /Code Mode program/i.test(transcriptText)) return "B";
  return "A";
}

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

function assistantCount(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}

function pickTaskId(text: string, extraKeys: readonly string[]): string | undefined {
  const keys = new Set<string>([
    ...Object.keys(ARM_A_SEQUENCES),
    ...Object.keys(MOCK_PROGRAMS),
    ...extraKeys,
  ]);
  const ordered = [...keys].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return ordered.find((k) => text.includes(k));
}

function filterCalls(
  calls: readonly MockToolCall[],
  tools: readonly ToolDescriptor[],
): MockToolCall[] {
  if (tools.length === 0) return [...calls];
  const available = new Set(tools.map((t) => t.name));
  const kept = calls.filter((c) => available.has(c.name));
  return kept.length > 0 ? kept : [...calls];
}

export function createMockDriver(opts: MockDriverOptions = {}): ModelDriver {
  const seed = opts.seed ?? 1;
  const usageModel = opts.usageModel ?? "cached-heavy";
  const overrides = opts.programs ?? {};

  return {
    id: "mock",

    async complete(req): Promise<ModelResponse> {
      const text = req.messages.map((m) => m.text).join("\n");
      const arm = detectArm(req.tools, text);
      const taskId = pickTaskId(text, Object.keys(overrides));
      const step = assistantCount(req.messages);
      const usage = synthesizeUsage(seed, step, usageModel);

      if (arm === "A") {
        const canned = (taskId !== undefined ? ARM_A_SEQUENCES[taskId] : undefined) ?? GENERIC_ARM_A;
        const sequence = filterCalls(canned.calls, req.tools);
        const maxTurns = req.maxTurns;
        const atLimit = maxTurns !== undefined && step >= maxTurns;
        if (atLimit || step >= sequence.length) {
          const override = taskId !== undefined ? overrides[taskId]?.A : undefined;
          return { text: override ?? canned.final, toolCalls: [], usage };
        }
        const call = sequence[step] as MockToolCall;
        return {
          text: "",
          toolCalls: [{ name: call.name, input: call.input }],
          usage,
        };
      }

      // Script arms are single-shot: one model call produces one program.
      if (step > 0) return { text: "", toolCalls: [], usage };

      const override = taskId !== undefined ? overrides[taskId]?.[arm] : undefined;
      const canned = taskId !== undefined ? MOCK_PROGRAMS[taskId]?.[arm] : undefined;
      const program = override ?? canned ?? GENERIC_PROGRAM.join("\n");

      const execName = executeToolName(req.tools);
      const toolCalls =
        execName !== undefined ? [{ name: execName, input: { code: program } as Json }] : [];
      return { text: program, toolCalls, usage };
    },
  };
}
