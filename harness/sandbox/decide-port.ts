/**
 * Structural mirrors of the frozen `decide` contract (`docs/CONTRACTS.md` §1).
 *
 * The harness types the decide seam without importing `src/decide/index.ts` directly, so that
 * `harness/runner/**` and the sandbox stay decoupled from worker A's module layout (and so tests
 * can inject a stub). These declarations are *structural mirrors* of §1 — same names, same shapes —
 * used for the injected factory seam and by the harness's arm-C wiring; the real types live in
 * `src/decide/index.ts` (§1), and `../runner/sources.ts` loads that module and asserts its shape.
 *
 * If §1 changes, update this file — do NOT change the contract.
 */

import type { Json } from "../types.ts";

export const DECIDE_TOOL_NAME = "decide";
export const DECIDE_NAMESPACE = "typesafe";

export interface NoulQuestion {
  mode: "noul";
  id: string;
  criterion?: string;
  criteria: { true: string; false: string };
  escalateBelow?: number;
}
export interface ChoiceQuestion {
  mode: "choice";
  id: string;
  criterion?: string;
  options: Record<string, string | null>;
  escalateBelow?: number;
}
export interface ScoreQuestion {
  mode: "score";
  id: string;
  criterion?: string;
  levels: string[];
  escalateBelow?: number;
}
export type DecideQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecideCall {
  state: string | Json;
  questions: DecideQuestion | DecideQuestion[];
  escalateBelow?: number;
  model?: string;
  cache?: boolean;
  timeoutMs?: number;
}

export interface DecideVerdict {
  id: string;
  mode: "noul" | "choice" | "score";
  value: boolean | string | number;
  p?: number;
  probabilities?: Record<string, number>;
  confidence: number;
  modelId: string;
  latencyMs: number;
  cached: boolean;
  escalate: boolean;
  reason?: string;
}

export interface SystemOneQuestion {
  type: "noul" | "choice" | "score";
  instructions?: string;
  criteria?: Json;
}
export interface SystemOneRequest {
  state: Json;
  questions: Record<string, SystemOneQuestion>;
  model?: string;
}
export interface SystemOneAnswer {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}
export interface SystemOneResult {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number | null; output_tokens: number | null };
}

export interface Judge {
  readonly modelId: string;
  systemOne(
    req: SystemOneRequest,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SystemOneResult>;
}

export interface StoragePort {
  get(key: string): Promise<Json | undefined>;
  set(key: string, value: Json): Promise<void>;
}

/** One decision-log entry, as emitted by `createDecideRuntime`'s `log` sink. */
export interface DecideLogEntry {
  at: number;
  modelId: string;
  latencyMs: number;
  cached: boolean;
  questionIds: string[];
  verdicts: DecideVerdict[];
  usage?: { input_tokens: number | null; output_tokens: number | null };
}

export interface DecidePluginTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  options: { namespace: string; codemode: true; pinned: true } | undefined;
  execute(input: unknown, context?: unknown): Promise<{ output: DecideVerdict | DecideVerdict[]; content: string }>;
}

export interface DecideRuntime {
  call(call: DecideCall): Promise<DecideVerdict | DecideVerdict[]>;
  tool: DecidePluginTool;
}

export interface DecideRuntimeDeps {
  judge: Judge;
  storage: StoragePort;
  log?: (entry: Json) => void | Promise<void>;
  now?: () => number;
  hash?: (input: string) => string;
}

export type DecideRuntimeFactory = (deps: DecideRuntimeDeps) => DecideRuntime;

/** Sink used by D1 to capture §1 decision-log entries into an `ArmResult`. */
export type DecideLogSink = (entry: DecideLogEntry) => void;
