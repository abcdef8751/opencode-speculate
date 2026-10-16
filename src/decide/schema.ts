/**
 * JSON Schemas for the `decide` plugin tool — frozen contract `docs/CONTRACTS.md` §1.
 *
 * `DECIDE_INPUT_SCHEMA` is what the model writes; `DECIDE_OUTPUT_SCHEMA` is what Code Mode
 * receives (the structured `DecideVerdict | DecideVerdict[]`).
 */

/** One question object, shared by the single-question and array variants of `questions`. */
const QUESTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["mode", "id"],
  properties: {
    mode: {
      enum: ["noul", "choice", "score"],
      description: "noul: yes/no · choice: pick one label · score: an ordered rubric",
    },
    id: {
      type: "string",
      description: "Stable identifier for this question; used as the verdict key.",
    },
    criterion: {
      type: "string",
      description: "What is being judged, in plain language. Keep it atomic.",
    },
    criteria: {
      type: "object",
      properties: {
        true: { type: "string" },
        false: { type: "string" },
      },
      required: ["true", "false"],
      additionalProperties: false,
      description: "noul only: descriptions of the true and false outcomes.",
    },
    options: {
      type: "object",
      minProperties: 1,
      additionalProperties: { type: ["string", "null"] },
      description: "choice only: label → description (or null for an undescribed label).",
    },
    levels: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      description: "score only: the ordered rubric, levels[0] = score 0.",
    },
    escalateBelow: {
      type: "number",
      description: "Per-question override for the call-level escalation threshold.",
    },
  },
  additionalProperties: false,
}

const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "id",
    "mode",
    "value",
    "confidence",
    "modelId",
    "latencyMs",
    "cached",
    "escalate",
  ],
  properties: {
    id: { type: "string" },
    mode: { enum: ["noul", "choice", "score"] },
    value: { oneOf: [{ type: "boolean" }, { type: "string" }, { type: "number" }] },
    p: { type: "number" },
    probabilities: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    confidence: { type: "number" },
    modelId: { type: "string" },
    latencyMs: { type: "number" },
    cached: { type: "boolean" },
    escalate: { type: "boolean" },
    reason: { type: "string" },
  },
  additionalProperties: false,
}

/** JSON Schema for the plugin tool's `input` (what the model writes). */
export const DECIDE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    state: {
      description:
        "Text or JSON to judge. Keep it self-contained (the judge sees only this).",
    },
    questions: {
      oneOf: [
        QUESTION_SCHEMA,
        { type: "array", items: QUESTION_SCHEMA, minItems: 1 },
      ],
      description:
        "One question object → one verdict object; an array → an array of verdicts. One array is one judge request.",
    },
    escalateBelow: {
      type: "number",
      description:
        "Default escalation threshold in [0,1] for every question; a verdict escalates when its confidence is below it. Absent ⇒ never escalate.",
    },
    model: { type: "string", description: "Override the pinned judge model id for this call." },
    cache: { type: "boolean", default: true },
    timeoutMs: { type: "number", description: "Per-request timeout in milliseconds." },
  },
  required: ["state", "questions"],
  additionalProperties: false,
}

/** JSON Schema for the plugin tool's `output` (what Code Mode receives). */
export const DECIDE_OUTPUT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    VERDICT_SCHEMA,
    { type: "array", items: VERDICT_SCHEMA },
  ],
}
