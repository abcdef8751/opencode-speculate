/**
 * Public types for the `decide()` engine — frozen contract `docs/CONTRACTS.md` §1.
 *
 * This file is the single source of truth for the vocabulary that `src/index.ts` (the plugin
 * entry) and the harness both code against. Keep it dependency-free: it must not import the SDK.
 */

/** A JSON-compatible value. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/* ------------------------------------------------------------------ *
 * Question DSL — exactly what a model/script writes
 * ------------------------------------------------------------------ */

/** A yes/no question. `criteria` describes both outcomes in words. */
export interface NoulQuestion {
  mode: "noul"
  id: string
  criterion?: string
  criteria: { true: string; false: string }
  escalateBelow?: number
}

/** A question that selects one of `options` (label → description, or `null`). */
export interface ChoiceQuestion {
  mode: "choice"
  id: string
  criterion?: string
  options: Record<string, string | null>
  escalateBelow?: number
}

/** A question scored against an ordered rubric (`levels[0]` is score 0). */
export interface ScoreQuestion {
  mode: "score"
  id: string
  criterion?: string
  levels: string[]
  escalateBelow?: number
}

export type DecideQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/* ------------------------------------------------------------------ *
 * One call
 * ------------------------------------------------------------------ */

export interface DecideCall {
  /** Judge `state`: text or structured JSON. Keep it self-contained. */
  state: string | Json
  /** A single question object ⇒ a single verdict; an array ⇒ an array of verdicts. */
  questions: DecideQuestion | DecideQuestion[]
  /** Default escalation threshold for every question; absent ⇒ never escalate. */
  escalateBelow?: number
  /** Override the judge's pinned model id for this call. */
  model?: string
  /** Use the storage-backed cache. Default `true`. */
  cache?: boolean
  /** Per-request timeout in milliseconds (the judge's default when omitted). */
  timeoutMs?: number
}

/* ------------------------------------------------------------------ *
 * Per-question verdict
 * ------------------------------------------------------------------ */

export interface DecideVerdict {
  id: string
  mode: "noul" | "choice" | "score"
  /** `noul` ⇒ boolean, `choice` ⇒ chosen label, `score` ⇒ expected score (may be fractional). */
  value: boolean | string | number
  /** `noul` only: P(true). */
  p?: number
  /** `choice`: keyed by label; `score`: keyed by level index (`"0"`, `"1"`, …). */
  probabilities?: Record<string, number>
  /** Normalized confidence — see the formulas in `engine.ts`. */
  confidence: number
  modelId: string
  latencyMs: number
  cached: boolean
  escalate: boolean
  /** Present iff `escalate === true`; a short, JSON-safe sentence naming the cause. */
  reason?: string
}

/* ------------------------------------------------------------------ *
 * Storage / backend seam
 * ------------------------------------------------------------------ */

/** The minimal JSON KV the engine needs (wired to `ctx.storage` by the plugin). */
export interface StoragePort {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
}

/** One question, in the shape the systemone endpoint accepts. */
export interface SystemOneQuestion {
  type: "noul" | "choice" | "score"
  instructions?: string
  criteria?: Json
}

export interface SystemOneRequest {
  state: Json
  questions: Record<string, SystemOneQuestion>
  model?: string
}

/** One answer as returned by the systemone endpoint. */
export interface SystemOneAnswer {
  type: string
  /** `noul`: probability of true. */
  noul?: number
  /** `choice`: the selected label. */
  choice?: string
  /** `score`: the expected score (may be fractional). */
  score?: number
  /** `choice`/`score` only; `null` when the API did not report it. */
  confidence?: number | null
  /** Keyed by label (`choice`) or level index (`score`). */
  probabilities?: Record<string, number>
  /** `score` only: level index → description. */
  legend?: Record<string, string>
}

export interface SystemOneUsage {
  input_tokens: number | null
  output_tokens: number | null
}

export interface SystemOneResult {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage?: SystemOneUsage
}

/** The backend seam. Default = Liquid AI `d1-ultra`; any systemone-compatible backend fits. */
export interface Judge {
  readonly modelId: string
  systemOne(
    req: SystemOneRequest,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SystemOneResult>
}

/* ------------------------------------------------------------------ *
 * Plugin tool
 * ------------------------------------------------------------------ */

export const DECIDE_TOOL_NAME = "decide"
export const DECIDE_NAMESPACE = "typesafe"

/** The plugin tool definition, ready for `editor.add(...)`. */
export interface DecidePluginTool {
  name: typeof DECIDE_TOOL_NAME
  description: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  options: { namespace: typeof DECIDE_NAMESPACE; codemode: true; pinned: true }
  execute(
    input: unknown,
    context?: unknown,
  ): Promise<{ output: DecideVerdict | DecideVerdict[]; content: string }>
}
