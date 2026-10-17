/**
 * Frozen cross-boundary types for the measurement harness.
 *
 * OWNER: orchestrator. Workers D1 (`harness/runner/**`, `harness/metrics/**`, `harness/report.ts`,
 * `harness/sandbox/**`) and D2 (`harness/tasks/**`, `harness/drivers/**`, `harness/fixtures/**`)
 * both code against this file. If something here is wrong for an implementation, report it —
 * do not edit it.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export type TaskKind = "long-loop" | "medium" | "one-shot"

export interface TaskVerifyResult {
  passed: boolean
  detail?: string
}

/**
 * One measurement task. `dir` is a fresh scratch copy of the fixture per run, created by the
 * runner from `fixture` — tasks never mutate `harness/fixtures/**` in place.
 */
export interface TaskDef {
  id: string
  title: string
  kind: TaskKind
  /** Fixture directory, relative to the repo root, copied per run. */
  fixture: string
  /** Prompt for arm A (the agent calls tools turn by turn). */
  prompt: string
  /** Prompt for arms B and C (write one Code Mode script). */
  scriptPrompt: string
  /** For arm C: extra instruction demanding the `escalate` handler (`break` in a loop, `return` at top level). */
  escalationPrompt?: string
  /** Tools this task needs; a subset of ToolBox names. Defaults to all sandbox tools. */
  tools?: readonly string[]
  /** Optional post-copy mutation of the scratch dir (e.g. writing a broken file). */
  setup?(dir: string): Promise<void>
  verify(dir: string): Promise<TaskVerifyResult>
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export interface ToolDescriptor {
  name: string
  description: string
  /** JSON Schema, for the model-facing tool list. */
  input: Record<string, unknown>
}

/** Executes a tool by name against a scratch directory. */
export interface ToolBox {
  readonly dir: string
  readonly descriptors: readonly ToolDescriptor[]
  /** Names actually available to the model / the sandbox for this run. */
  readonly names: readonly string[]
  call(name: string, input: unknown, signal?: AbortSignal): Promise<Json>
}

/* ------------------------------------------------------------------ *
 * Model drivers
 * ------------------------------------------------------------------ */

export interface TokenUsage {
  /** Uncached input tokens. */
  fresh: number
  cacheWrite: number
  cacheRead: number
  output: number
  /** Attributed cost in USD, when the driver can compute it. */
  costUsd?: number
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  text: string
  /** Set on assistant messages that requested tools. */
  toolCalls?: { name: string; input: unknown }[]
  /** Set on tool messages. */
  toolName?: string
}

export interface ModelResponse {
  text: string
  toolCalls: { name: string; input: unknown }[]
  usage: TokenUsage
}

export interface ModelDriver {
  readonly id: string
  /** One model turn: given the transcript and the available tools, produce the next step. */
  complete(req: {
    messages: readonly ChatMessage[]
    tools: readonly ToolDescriptor[]
    maxTurns?: number
    signal?: AbortSignal
  }): Promise<ModelResponse>
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type ArmID = "A" | "B" | "C"

export interface DecideCallRecord {
  at: number
  modelId: string
  latencyMs: number
  cached: boolean
  questionIds: string[]
  verdicts: { id: string; mode: string; value: Json; confidence: number; escalate: boolean }[]
}

export interface ArmResult {
  arm: ArmID
  taskId: string
  runIndex: number
  /** The arm completed without a harness-level error (not the same as task correctness). */
  ok: boolean
  error?: string
  /** Main-model turns consumed. */
  turns: number
  usage: TokenUsage
  wallMs: number
  /** Every tool call the arm made, in order. */
  toolCalls: string[]
  /** Tool calls the caller had to admit/deny; failures inside the sandbox. */
  toolFailures: number
  correctness: TaskVerifyResult
  /** The script (B/C) or the final assistant text (A), for inspection. */
  transcript: string
  /** Sandbox logs / console output. */
  logs: string[]
  decideCalls: DecideCallRecord[]
  decideLatencyMs: number
  /** Arm declared escalation (`decide(...).escalate` was observed). */
  escalated: boolean
  escalations: number
  /** Script-level parse/exec failures and model debug cycles. */
  scriptFailures: number
  notes: string[]
}

export interface RunReport {
  startedAt: string
  finishedAt: string
  driver: string
  runs: number
  results: ArmResult[]
  /** Per-arm aggregates keyed by arm. */
  summary: Record<ArmID, ArmSummary>
}

export interface ArmSummary {
  runs: number
  ok: number
  correctnessPassed: number
  turnsMean: number
  cacheReadTokensMean: number
  freshTokensMean: number
  outputTokensMean: number
  costUsdMean?: number
  wallMsMean: number
  toolCallsMean: number
  escalationRate: number
  scriptFailureRate: number
  decideCallsMean: number
}

/** The plan's gate, evaluated over arm B vs C (and A as the baseline). */
export interface GateVerdict {
  cacheReadDownVsA: boolean
  cacheReadDownVsB: boolean
  correctnessEqualOrBetter: boolean
  escalationLow: boolean
  pass: boolean
  notes: string[]
}
