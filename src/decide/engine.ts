/**
 * The `decide()` engine — batching, verdict assembly, confidence math, escalation, cache, log.
 *
 * Everything here is pure/deterministic except `runDecide`, which is handed a `Judge`, a
 * `StoragePort`, and injectable `now`/`hash` so tests never touch the network or wall clock.
 * Contract: `docs/CONTRACTS.md` §1.
 */

import { createHash } from "node:crypto"
import type {
  DecideCall,
  DecideQuestion,
  DecideVerdict,
  Json,
  Judge,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  StoragePort,
  SystemOneAnswer,
  SystemOneQuestion,
  SystemOneResult,
  SystemOneUsage,
} from "./types"

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

export interface EngineDeps {
  judge: Judge
  storage: StoragePort
  /** One entry per judge request (or per all-cached batch). Must never throw into the caller. */
  log?: (entry: Json) => void | Promise<void>
  /** Default `Date.now`. */
  now?: () => number
  /** Default sha256 hex. */
  hash?: (input: string) => string
}

export interface EngineRunOptions {
  /** Propagated to the judge as a per-request `AbortSignal`. */
  signal?: AbortSignal
}

/** The verdict as persisted: cache entries drop the per-call `latencyMs`/`cached`. */
export type CachedVerdict = Omit<DecideVerdict, "latencyMs" | "cached">

export const defaultHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex")

export const defaultNow = (): number => Date.now()

/* ------------------------------------------------------------------ *
 * Stable stringify + cache key
 * ------------------------------------------------------------------ */

/** Deterministic JSON: object keys sorted recursively, so equal values key equal. */
export function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const record = value as { [k: string]: Json }
  const keys = Object.keys(record).sort()
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key] as Json)}`)
    .join(",")
  return `{${body}}`
}

/** `decide/cache/<sha256 of stable-stringified {state, question}>`. */
export function decideCacheKey(
  hash: (input: string) => string,
  state: Json,
  question: DecideQuestion,
): string {
  const payload = { state, question } as unknown as Json
  return `decide/cache/${hash(stableStringify(payload))}`
}

/* ------------------------------------------------------------------ *
 * Confidence normalization (pure) — contract formulas
 * ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** `noul`: `|2p − 1|`. */
export function normalizeNoulConfidence(p: number): number {
  if (!Number.isFinite(p)) return 0
  return clamp01(Math.abs(2 * p - 1))
}

/**
 * `choice`: `(p_max − 1/n) / (1 − 1/n)` with `n = Object.keys(options).length`; `n === 1 ⇒ 1`.
 * Clamped to `[0,1]` for robustness (the raw ratio can leave the range only on malformed input).
 */
export function normalizeChoiceConfidence(
  probabilities: Record<string, number>,
  optionCount: number,
): number {
  if (!Number.isFinite(optionCount) || optionCount <= 0) return 0
  if (optionCount === 1) return 1
  const values = Object.values(probabilities).filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  )
  if (values.length === 0) return 0
  const pMax = Math.max(...values)
  const raw = (pMax - 1 / optionCount) / (1 - 1 / optionCount)
  return clamp01(raw)
}

/** `score`: the API's `confidence` as-is (`null`/absent ⇒ `0`). */
export function normalizeScoreConfidence(confidence: number | null | undefined): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return 0
  return clamp01(confidence)
}

/* ------------------------------------------------------------------ *
 * Escalation (pure)
 * ------------------------------------------------------------------ */

/** Per-question override wins; a non-finite value anywhere means "no threshold". */
export function effectiveThreshold(
  question: DecideQuestion,
  call: Pick<DecideCall, "escalateBelow">,
): number | undefined {
  const raw = question.escalateBelow ?? call.escalateBelow
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

export interface EscalationInput {
  confidence: number
  threshold?: number | undefined
  /** Present when the answer for this id was missing/unusable. */
  unusable?: string | undefined
}

/** Opt-in: no threshold and a usable answer ⇒ never escalate. */
export function escalationFor(input: EscalationInput): {
  escalate: boolean
  reason?: string
} {
  const causes: string[] = []
  if (input.unusable) causes.push(input.unusable)
  const threshold = input.threshold
  if (
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    input.confidence < threshold
  ) {
    causes.push(
      `confidence ${input.confidence.toFixed(3)} is below the escalation threshold ${threshold}`,
    )
  }
  if (causes.length === 0) return { escalate: false }
  return { escalate: true, reason: causes.join("; ") }
}

/* ------------------------------------------------------------------ *
 * Question validation + SDK mapping
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Validate one (possibly untrusted) question and return the normalized form. */
export function validateQuestion(input: unknown, index: number): DecideQuestion {
  if (!isPlainObject(input)) {
    throw new Error(`decide: question at index ${index} must be an object`)
  }
  const id = input.id
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`decide: question at index ${index} needs a non-empty string "id"`)
  }
  const mode = input.mode
  if (mode !== "noul" && mode !== "choice" && mode !== "score") {
    throw new Error(
      `decide: question "${id}" has unknown mode ${JSON.stringify(mode)} (expected noul|choice|score)`,
    )
  }
  const criterion = input.criterion
  if (criterion !== undefined && typeof criterion !== "string") {
    throw new Error(`decide: question "${id}" criterion must be a string`)
  }
  const escalateBelow = input.escalateBelow
  if (escalateBelow !== undefined && typeof escalateBelow !== "number") {
    throw new Error(`decide: question "${id}" escalateBelow must be a number`)
  }

  if (mode === "noul") {
    const criteria = input.criteria
    if (!isPlainObject(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") {
      throw new Error(`decide: noul question "${id}" needs string criteria.true and criteria.false`)
    }
    const question: NoulQuestion = {
      mode,
      id,
      criteria: { true: criteria.true, false: criteria.false },
    }
    if (criterion !== undefined) question.criterion = criterion
    if (escalateBelow !== undefined) question.escalateBelow = escalateBelow
    return question
  }

  if (mode === "choice") {
    const options = input.options
    if (!isPlainObject(options) || Object.keys(options).length === 0) {
      throw new Error(`decide: choice question "${id}" needs a non-empty options map`)
    }
    const normalized: Record<string, string | null> = {}
    for (const [label, description] of Object.entries(options)) {
      if (description !== null && typeof description !== "string") {
        throw new Error(
          `decide: choice question "${id}" option "${label}" must be a string or null`,
        )
      }
      normalized[label] = description
    }
    const question: ChoiceQuestion = { mode, id, options: normalized }
    if (criterion !== undefined) question.criterion = criterion
    if (escalateBelow !== undefined) question.escalateBelow = escalateBelow
    return question
  }

  const levels = input.levels
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new Error(`decide: score question "${id}" needs at least two levels`)
  }
  for (const level of levels) {
    if (typeof level !== "string") {
      throw new Error(`decide: score question "${id}" levels must be strings`)
    }
  }
  const question: ScoreQuestion = { mode, id, levels: levels as string[] }
  if (criterion !== undefined) question.criterion = criterion
  if (escalateBelow !== undefined) question.escalateBelow = escalateBelow
  return question
}

/** Single object ⇒ `[q]`; array ⇒ copy. Rejects empty arrays and duplicate ids. */
export function normalizeQuestions(
  input: DecideQuestion | DecideQuestion[],
): DecideQuestion[] {
  const list = Array.isArray(input) ? input : [input]
  if (list.length === 0) throw new Error("decide: questions must not be empty")
  const seen = new Set<string>()
  const out: DecideQuestion[] = []
  for (let index = 0; index < list.length; index += 1) {
    const question = validateQuestion(list[index], index)
    if (seen.has(question.id)) {
      throw new Error(`decide: duplicate question id "${question.id}" in one call`)
    }
    seen.add(question.id)
    out.push(question)
  }
  return out
}

/** Map a DSL question to the SDK/HTTP `{ type, instructions, criteria }` shape. */
export function toSystemOneQuestion(question: DecideQuestion): SystemOneQuestion {
  switch (question.mode) {
    case "noul": {
      const mapped: SystemOneQuestion = {
        type: "noul",
        criteria: { true: question.criteria.true, false: question.criteria.false },
      }
      if (question.criterion !== undefined) mapped.instructions = question.criterion
      return mapped
    }
    case "choice": {
      const mapped: SystemOneQuestion = {
        type: "choice",
        criteria: { ...question.options },
      }
      if (question.criterion !== undefined) mapped.instructions = question.criterion
      return mapped
    }
    case "score": {
      const mapped: SystemOneQuestion = { type: "score", criteria: [...question.levels] }
      if (question.criterion !== undefined) mapped.instructions = question.criterion
      return mapped
    }
  }
}

/* ------------------------------------------------------------------ *
 * Answer → verdict facts
 * ------------------------------------------------------------------ */

export interface VerdictFacts {
  value: DecideVerdict["value"]
  p?: number
  probabilities?: Record<string, number>
  confidence: number
  /** Present when the answer was missing/unusable; feeds the escalation reason. */
  unusable?: string
}

function finiteProbabilities(
  probabilities: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!isPlainObject(probabilities)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(probabilities)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Derive the mode-specific value/confidence for one question from its raw answer. */
export function verdictFacts(
  question: DecideQuestion,
  answer: SystemOneAnswer | undefined,
): VerdictFacts {
  // A missing/unusable answer is NOT a thrown error (that is reserved for transport/HTTP/parse
  // failures of the whole request). It yields a conservative value with `confidence: 0` and an
  // `unusable` cause so `assembleVerdict` can force `escalate: true` with a reason. The value is
  // never trusted: escalation is the only signal that matters on this path.
  if (question.mode === "noul") {
    const p = answer?.noul
    if (typeof p === "number" && Number.isFinite(p)) {
      return {
        // Jev returns P(true) only; the boolean decision rule is the natural p >= 0.5.
        value: p >= 0.5,
        p: clamp01(p),
        confidence: normalizeNoulConfidence(p),
      }
    }
    return {
      value: false,
      confidence: 0,
      unusable: `no usable noul answer returned for question "${question.id}"`,
    }
  }

  if (question.mode === "choice") {
    const label = answer?.choice
    const optionCount = Object.keys(question.options).length
    if (typeof label === "string" && label.length > 0) {
      const probabilities = finiteProbabilities(answer?.probabilities)
      const facts: VerdictFacts = {
        value: label,
        confidence:
          probabilities !== undefined
            ? normalizeChoiceConfidence(probabilities, optionCount)
            // Fallback for backends that omit probabilities (e.g. the harness fakeJudge):
            // use the API's own confidence rather than reporting 0.
            : normalizeScoreConfidence(answer?.confidence),
      }
      if (probabilities !== undefined) facts.probabilities = probabilities
      if (!Object.prototype.hasOwnProperty.call(question.options, label)) {
        facts.unusable = `choice answer "${label}" is not one of the declared options for question "${question.id}"`
      }
      return facts
    }
    return {
      value: "",
      confidence: 0,
      unusable: `no usable choice answer returned for question "${question.id}"`,
    }
  }

  const score = answer?.score
  if (typeof score === "number" && Number.isFinite(score)) {
    const facts: VerdictFacts = {
      value: score,
      confidence: normalizeScoreConfidence(answer?.confidence),
    }
    const probabilities = finiteProbabilities(answer?.probabilities)
    if (probabilities !== undefined) facts.probabilities = probabilities
    return facts
  }
  return {
    value: 0,
    confidence: 0,
    unusable: `no usable score answer returned for question "${question.id}"`,
  }
}

export interface VerdictContext {
  modelId: string
  latencyMs: number
  threshold?: number | undefined
}

/** Assemble a `DecideVerdict` from already-derived facts (shared by fresh and cached paths). */
function assembleVerdictFromFacts(
  question: DecideQuestion,
  facts: VerdictFacts,
  ctx: VerdictContext,
): DecideVerdict {
  const { escalate, reason } = escalationFor({
    confidence: facts.confidence,
    threshold: ctx.threshold,
    unusable: facts.unusable,
  })
  const verdict: DecideVerdict = {
    id: question.id,
    mode: question.mode,
    value: facts.value,
    confidence: facts.confidence,
    modelId: ctx.modelId,
    latencyMs: ctx.latencyMs,
    cached: false,
    escalate,
  }
  if (facts.p !== undefined) verdict.p = facts.p
  if (facts.probabilities !== undefined) verdict.probabilities = facts.probabilities
  if (reason !== undefined) verdict.reason = reason
  return verdict
}

/** Assemble the full `DecideVerdict` (value + confidence + escalation) for one question. */
export function assembleVerdict(
  question: DecideQuestion,
  answer: SystemOneAnswer | undefined,
  ctx: VerdictContext,
): DecideVerdict {
  return assembleVerdictFromFacts(question, verdictFacts(question, answer), ctx)
}

/* ------------------------------------------------------------------ *
 * Cache serialization
 * ------------------------------------------------------------------ */

/** Strip the per-call fields; only the durable verdict facts are stored. */
export function toCachedVerdict(verdict: DecideVerdict): CachedVerdict {
  const cached: CachedVerdict = {
    id: verdict.id,
    mode: verdict.mode,
    value: verdict.value,
    confidence: verdict.confidence,
    modelId: verdict.modelId,
    escalate: verdict.escalate,
  }
  if (verdict.p !== undefined) cached.p = verdict.p
  if (verdict.probabilities !== undefined) cached.probabilities = verdict.probabilities
  if (verdict.reason !== undefined) cached.reason = verdict.reason
  return cached
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v))
  )
}

/** Tolerant read-side validator: a corrupt/old entry is simply a cache miss. */
export function parseCachedVerdict(raw: Json | undefined): CachedVerdict | undefined {
  if (!isPlainObject(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  if (record.mode !== "noul" && record.mode !== "choice" && record.mode !== "score") {
    return undefined
  }
  const value = record.value
  if (typeof value !== "boolean" && typeof value !== "string") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) {
    return undefined
  }
  if (typeof record.modelId !== "string") return undefined
  if (typeof record.escalate !== "boolean") return undefined
  const cached: CachedVerdict = {
    id: record.id,
    mode: record.mode,
    value,
    confidence: record.confidence,
    modelId: record.modelId,
    escalate: record.escalate,
  }
  if (typeof record.p === "number" && Number.isFinite(record.p)) cached.p = record.p
  if (isNumberRecord(record.probabilities)) cached.probabilities = record.probabilities
  if (typeof record.reason === "string") cached.reason = record.reason
  return cached
}

/* ------------------------------------------------------------------ *
 * The batching run
 * ------------------------------------------------------------------ */

function normalizeUsage(usage: SystemOneResult["usage"]): SystemOneUsage {
  return {
    input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
  }
}

function asJudgeError(err: unknown): Error {
  if (err instanceof Error) return err
  return new Error(`decide: judge request failed: ${String(err)}`)
}

async function safeLog(
  log: EngineDeps["log"],
  entry: Json,
): Promise<void> {
  if (!log) return
  try {
    await log(entry)
  } catch {
    // Logging must never throw into the caller path.
  }
}

export interface DecideLogEntry {
  at: number
  modelId: string
  latencyMs: number
  cached: boolean
  questionIds: string[]
  verdicts: DecideVerdict[]
  usage: SystemOneUsage
}

/**
 * Run one `decide` call.
 *
 * Array of questions ⇒ ONE judge request. A question may hit the cache while siblings miss, but
 * the judge request is skipped entirely only when every question hits. Fail loud on judge error.
 */
export async function runDecide(
  deps: EngineDeps,
  call: DecideCall,
  opts: EngineRunOptions = {},
): Promise<DecideVerdict | DecideVerdict[]> {
  const now = deps.now ?? defaultNow
  const hash = deps.hash ?? defaultHash
  const startedAt = now()

  const questions = normalizeQuestions(call.questions)
  const order = questions.map((question) => question.id)
  const single = !Array.isArray(call.questions)
  const useCache = call.cache !== false

  // 1. Cache lookups (best-effort: a storage failure degrades to a miss). A stored entry is only
  // trusted when it is structurally valid AND belongs to this exact question — a stale/foreign
  // entry is a miss. Escalation is ALWAYS recomputed from the stored `confidence` and the
  // *current* effective threshold: the call-level `escalateBelow` is not part of the cache key, so
  // the stored `escalate`/`reason` may be stale.
  const hits = new Map<string, DecideVerdict>()
  if (useCache) {
    for (const question of questions) {
      const key = decideCacheKey(hash, call.state, question)
      try {
        const stored = parseCachedVerdict(await deps.storage.get(key))
        if (stored === undefined) continue
        if (stored.id !== question.id || stored.mode !== question.mode) continue
        const escalation = escalationFor({
          confidence: stored.confidence,
          threshold: effectiveThreshold(question, call),
        })
        const hit: DecideVerdict = {
          id: stored.id,
          mode: stored.mode,
          value: stored.value,
          confidence: stored.confidence,
          modelId: stored.modelId,
          latencyMs: 0,
          cached: true,
          escalate: escalation.escalate,
        }
        if (stored.p !== undefined) hit.p = stored.p
        if (stored.probabilities !== undefined) hit.probabilities = stored.probabilities
        if (escalation.reason !== undefined) hit.reason = escalation.reason
        hits.set(question.id, hit)
      } catch {
        // Treat as a miss.
      }
    }
  }

  const misses = questions.filter((question) => !hits.has(question.id))

  // 2. One judge request for the misses (skipped entirely when all hit).
  const fresh = new Map<string, DecideVerdict>()
  let modelId = deps.judge.modelId
  let usage: SystemOneUsage = { input_tokens: null, output_tokens: null }
  let latencyMs = 0

  if (misses.length > 0) {
    const questionsRecord: Record<string, SystemOneQuestion> = {}
    for (const question of misses) {
      questionsRecord[question.id] = toSystemOneQuestion(question)
    }
    const request = {
      state: call.state as Json,
      questions: questionsRecord,
      ...(call.model !== undefined ? { model: call.model } : {}),
    }

    const requestStarted = now()
    let result: SystemOneResult
    try {
      result = await deps.judge.systemOne(request, {
        signal: opts.signal,
        timeoutMs: call.timeoutMs,
      })
    } catch (err) {
      // Fail loud: no verdict, no log entry.
      throw asJudgeError(err)
    }
    latencyMs = Math.max(0, now() - requestStarted)

    if (!isPlainObject(result) || !isPlainObject(result.answers)) {
      throw new Error("decide: judge returned a malformed response (missing answers)")
    }
    modelId = typeof result.model === "string" && result.model.length > 0 ? result.model : deps.judge.modelId
    usage = normalizeUsage(result.usage)

    for (const question of misses) {
      const facts = verdictFacts(question, result.answers[question.id])
      const verdict = assembleVerdictFromFacts(question, facts, {
        modelId,
        latencyMs,
        threshold: effectiveThreshold(question, call),
      })
      fresh.set(question.id, verdict)
      // Only trustworthy verdicts are cached. An unusable/missing answer escalates on every call,
      // and because a hit recomputes escalation from `confidence` alone it would lose that
      // escalation — so its placeholder value must never be replayed from the cache.
      if (useCache && facts.unusable === undefined) {
        const key = decideCacheKey(hash, call.state, question)
        try {
          await deps.storage.set(key, toCachedVerdict(verdict) as unknown as Json)
        } catch {
          // Cache writes are best-effort.
        }
      }
    }
  }

  // 3. Merge in original order; a cached hit wins, otherwise the fresh verdict.
  const verdicts: DecideVerdict[] = order.map((id) => {
    const hit = hits.get(id)
    if (hit !== undefined) return hit
    const freshVerdict = fresh.get(id)
    if (freshVerdict !== undefined) return freshVerdict
    // Unreachable: every id is either a hit or a miss that was answered above.
    throw new Error(`decide: internal error — no verdict assembled for "${id}"`)
  })

  // 4. One decision-log entry per Jev request (§1). A batch served entirely from cache issues no
  // request, so it emits no entry. Never throws into the caller path.
  if (misses.length > 0) {
    const entry: Json = {
      at: startedAt,
      modelId,
      latencyMs,
      cached: false,
      questionIds: order,
      verdicts,
      usage,
    } as unknown as Json
    await safeLog(deps.log, entry)
  }

  if (single) {
    const verdict = verdicts[0]
    if (verdict === undefined) throw new Error("decide: internal error — empty verdict list")
    return verdict
  }
  return verdicts
}
