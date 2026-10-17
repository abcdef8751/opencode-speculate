/**
 * Feature C — the short session-context hint for `decide`.
 *
 * OWNER: worker C. Contract: `docs/CONTRACTS.md` §3.
 *
 * Injected by `src/index.ts` via `ctx.session.hook("context", …)`. Every identifier named
 * here exists in §1 (`DecideQuestion` / `DecideVerdict`); nothing else is invented.
 *
 * The escalation snippet is **self-contained and runnable**: it uses only identifiers it defines
 * (`out`, `d`) plus the Code Mode globals (`tools`, `console`). An earlier version looped over a
 * host-provided `steps` array that does not exist in the runtime, so a copied handler threw
 * `steps is not defined`. `src/hint.test.ts` executes this snippet for real to keep that true.
 */

import { DEFAULT_MODEL, type DecideConfig } from "./config.ts"

/** Max number of lines `decideHint` will return. */
export const DECIDE_HINT_MAX_LINES = 25

export function decideHint(config?: Pick<DecideConfig, "model">): string {
  const model = config?.model !== undefined && config.model.trim() !== "" ? config.model : DEFAULT_MODEL

  return [
    "## decide() — fuzzy judgement from Code Mode",
    'Call `tools.typesafe.decide({ state, questions, escalateBelow? })`. If that path is missing, run `search("decide")` to find it.',
    "One question → one verdict object; an array of questions → an array of verdicts — destructure or index it before reading `.escalate`. One judge request.",
    "",
    "`questions` takes ONE question object, or an ARRAY of them. Never an id-keyed map (`{ id: { … } }`):",
    'one:  questions: { mode: "noul", id: "q1", criterion: "…", criteria: { true: "…", false: "…" } }',
    'many: questions: [{ mode: "noul", id: "q1", … }, { mode: "choice", id: "q2", options: { "label": "…" } }]',
    "",
    "Question fields — `mode` + `id`, optional `criterion`, and one shape per mode:",
    'noul:   { mode:"noul",   id, criterion?, criteria:{ true:"…", false:"…" }, escalateBelow? } → `value` boolean, `p` = P(true)',
    'choice: { mode:"choice", id, criterion?, options:{ "label":"description", … }, escalateBelow? } → `value` = chosen label',
    'score:  { mode:"score",  id, criterion?, levels:["low","mid","high"], escalateBelow? } → `value` = expected score',
    "Keep `criterion` atomic: one claim per `id`; split compound questions into separate ids.",
    "",
    "Verdict: { id, mode, value, p?, probabilities?, confidence, modelId, latencyMs, cached, escalate, reason? } — `probabilities` is keyed by label (choice) or level index (score); `reason` appears iff `escalate === true`.",
    `\`escalate\` is true when \`confidence < escalateBelow\` (no threshold → never). Pinned model: ${model}.`,
    "",
    "Escalation — stop and report instead of guessing; `console.log` reaches you as `Logs:`:",
    'const out = await tools.shell({ command: "bun test 2>&1 | tail -40" })   // any step that produces evidence',
    'const [d] = await tools.typesafe.decide({ state: out.output, questions: [{ mode: "noul", id: "green?", criteria: { true: "all checks pass", false: "a check failed" } }], escalateBelow: 0.6 })',
    'if (d.escalate) { console.log(JSON.stringify({ reason: d.reason, excerpt: out.output.slice(-800) })); return { stop: true, reason: d.reason } }',
    "return { green: d.value }",
  ].join("\n")
}
