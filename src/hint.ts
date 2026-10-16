/**
 * Feature C — the short session-context hint for `decide`.
 *
 * OWNER: worker C. Contract: `docs/CONTRACTS.md` §3.
 *
 * Injected by `src/index.ts` via `ctx.session.hook("context", …)`. Every identifier named
 * here exists in §1 (`DecideQuestion` / `DecideVerdict`); nothing else is invented.
 */

import { DEFAULT_MODEL, type DecideConfig } from "./config.ts"

/** Max number of lines `decideHint` will return. */
export const DECIDE_HINT_MAX_LINES = 25

export function decideHint(config?: Pick<DecideConfig, "model">): string {
  const model = config?.model !== undefined && config.model.trim() !== "" ? config.model : DEFAULT_MODEL

  return [
    "## decide() — fuzzy judgement from Code Mode",
    'Call `tools.typesafe.decide({ state, questions, escalateBelow? })`. If that path is missing, run `search("decide")` to find it.',
    "One question → one verdict object; an array of questions → an array of verdicts, in one Jev request.",
    "",
    "Question shape — `mode` + `id`, plus `criterion` (the single atomic claim) and a threshold:",
    'noul:   { mode:"noul",   id, criterion?, criteria:{ true:"…", false:"…" }, escalateBelow? } → `value` boolean, `p` = P(true)',
    'choice: { mode:"choice", id, criterion?, options:{ "label":"description", … }, escalateBelow? } → `value` = chosen label',
    'score:  { mode:"score",  id, criterion?, levels:["low","mid","high"], escalateBelow? } → `value` = expected score',
    "Keep `criterion` atomic: one claim per `id`; split compound questions into separate ids.",
    "",
    "Verdict: { id, mode, value, p?, probabilities?, confidence, modelId, latencyMs, cached, escalate, reason? }",
    "`probabilities` is keyed by option label (choice) or level index (score). `reason` is present iff `escalate === true`.",
    `\`escalate\` is true when \`confidence < escalateBelow\` (no threshold → never). Pinned model: ${model}.`,
    "",
    "Escalation handler — `console.log` reaches you as `Logs:`, and `break` ends the script:",
    "const seen = [];",
    "for (const step of steps) {",
    "  const s = await step(); seen.push(s);",
    "  const d = await tools.typesafe.decide({ state: s.output, questions: { … }, escalateBelow: 0.6 });",
    "  if (d.escalate) { console.log(JSON.stringify({ reason: d.reason, last: seen.at(-1), done: seen.map(s => s.tool) })); break }",
    "}",
  ].join("\n")
}
