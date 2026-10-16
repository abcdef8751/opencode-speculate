/**
 * FALLBACK DRIVERS — offline stand-ins for worker D2's `harness/drivers/**` (mock driver, fake
 * judge) plus a real `opencode run` CLI driver.
 *
 * Only the mock + fake judge are used by the offline DoD run; the CLI driver is implemented and
 * documented but not executed here (`--driver opencode` needs a live model).
 *
 * OWNER: worker D1 (temporary).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatMessage, ModelDriver, ModelResponse, TokenUsage, ToolDescriptor } from "../../types.ts";
import { parseArmMarker } from "../arms/context.ts";
import { scenarioFor, type JudgeAnswer } from "./scenario.ts";
import type { Judge, SystemOneAnswer, SystemOneRequest, SystemOneResult } from "../../sandbox/decide-port.ts";

const execFileAsync = promisify(execFile);

export type UsageModel = "small" | "cached-heavy";

export interface MockDriverOptions {
  seed?: number;
  programs?: Record<string, { A?: string; B?: string; C?: string }>;
  usageModel?: UsageModel;
}

/**
 * Illustrative synthetic usage. `cached-heavy` models the effect the harness is built to measure:
 * arm A re-reads its context every turn, while a single script call reads it once. These numbers
 * are NOT measurements — the report labels them as synthetic.
 */
function usageFor(model: UsageModel, seed: number, arm: "A" | "B" | "C"): TokenUsage {
  if (model === "small") {
    return { fresh: 100 + (seed % 11), cacheWrite: 0, cacheRead: 0, output: 40 };
  }
  const cacheRead = arm === "A" ? 900 : 300;
  return { fresh: 20 + (seed % 7), cacheWrite: 10, cacheRead, output: 40 };
}

function parsePlan(text: string, taskId: string): { name: string; input: unknown }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`mock driver: programs["${taskId}"].A is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`mock driver: programs["${taskId}"].A must be a JSON array of tool calls`);
  return parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || typeof (entry as { name?: unknown }).name !== "string") {
      throw new Error(`mock driver: programs["${taskId}"].A entries need a string "name"`);
    }
    return { name: (entry as { name: string }).name, input: (entry as { input?: unknown }).input };
  });
}

/** Deterministic offline driver: canned tool plans (arm A) and canned programs (arms B/C). */
export function createMockDriver(opts: MockDriverOptions = {}): ModelDriver {
  const seed = opts.seed ?? 1;
  const usageModel = opts.usageModel ?? "cached-heavy";
  return {
    id: `mock:${usageModel}`,
    async complete(req: { messages: readonly ChatMessage[]; tools: readonly ToolDescriptor[] }): Promise<ModelResponse> {
      const marker = parseArmMarker(req.messages[0]?.text);
      if (marker === undefined) {
        throw new Error("mock driver: the first system message must carry the `harness:arm=...;task=...` marker");
      }
      const scenario = scenarioFor(marker.taskId);
      if (scenario === undefined) {
        throw new Error(
          `mock driver: no fallback scenario for task "${marker.taskId}" (known: ${["fallback-fix-typo", "fallback-count-todos", "fallback-long-loop"].join(", ")}); pass programs["${marker.taskId}"] to override`,
        );
      }
      const usage = usageFor(usageModel, seed, marker.arm);
      const override = opts.programs?.[marker.taskId]?.[marker.arm];

      if (marker.arm === "A") {
        const plan = override === undefined ? scenario.armAPlan : parsePlan(override, marker.taskId);
        const turn = req.messages.filter((message) => message.role === "assistant").length;
        if (turn < plan.length) {
          const step = plan[turn]!;
          return { text: `step ${turn + 1}: ${step.name}`, toolCalls: [{ name: step.name, input: step.input }], usage };
        }
        return { text: scenario.armAFinalText, toolCalls: [], usage };
      }

      const code = override ?? (marker.arm === "B" ? scenario.programB : scenario.programC);
      return { text: code, toolCalls: [], usage };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fake judge (offline §1 `Judge`)
 * ------------------------------------------------------------------ */

export interface FakeJudge extends Judge {
  /** Every `systemOne` request, in order — inspectable by tests and the report. */
  readonly calls: SystemOneRequest[];
}

/** Offline `Judge`: answers keyed by question id; missing ids answer with no usable value. */
export function createFakeJudge(script: Record<string, JudgeAnswer>): FakeJudge {
  const calls: SystemOneRequest[] = [];
  return {
    modelId: "fake-jev-v1",
    calls,
    async systemOne(req: SystemOneRequest): Promise<SystemOneResult> {
      calls.push(req);
      const answers: Record<string, SystemOneAnswer> = {};
      for (const [id, question] of Object.entries(req.questions)) {
        const answer = script[id];
        if (answer === undefined) {
          answers[id] = { type: question.type };
        } else if (answer.noul !== undefined) {
          answers[id] = { type: "noul", noul: answer.noul, confidence: answer.confidence ?? null };
        } else if (answer.choice !== undefined) {
          answers[id] = {
            type: "choice",
            choice: answer.choice,
            confidence: answer.confidence ?? null,
            probabilities: { [answer.choice]: 1 },
          };
        } else if (answer.score !== undefined) {
          answers[id] = { type: "score", score: answer.score, confidence: answer.confidence ?? null };
        } else {
          answers[id] = { type: question.type, confidence: answer.confidence ?? null };
        }
      }
      return { model: "fake-jev-v1", answers, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Real `opencode run` CLI driver
 * ------------------------------------------------------------------ */

export interface OpenCodeCliDriverOptions {
  model?: string;
  agent?: string;
  binary?: string;
  timeoutMs?: number;
}

export interface ParsedCliOutput {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TokenUsage;
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Tolerant parser for `opencode run --format json` output.
 *
 * ASSUMPTIONS (documented in `harness/README.md`): stdout is one JSON value per line; usage lives
 * in an object whose keys are snake_case or camelCase variants of input/output/cache-read/
 * cache-write; the last usage object seen is the run total. Anything else is collected into
 * `notes` instead of failing the run.
 */
export function parseOpenCodeJsonOutput(stdout: string): ParsedCliOutput {
  const notes: string[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  let text = "";
  let usage: TokenUsage | undefined;

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || !isRecord(value)) return;
    const usageCandidate = isRecord(value.usage)
      ? value.usage
      : isRecord(value.tokens)
        ? value.tokens
        : isRecord(value.tokenUsage)
          ? value.tokenUsage
          : undefined;
    if (usageCandidate !== undefined) {
      const input = pickNumber(usageCandidate, ["input_tokens", "inputTokens", "input", "prompt_tokens", "promptTokens"]);
      const output = pickNumber(usageCandidate, ["output_tokens", "outputTokens", "output", "completion_tokens", "completionTokens"]);
      const cacheRead = pickNumber(usageCandidate, ["cache_read_input_tokens", "cacheReadInputTokens", "cache_read", "cacheRead", "cached_tokens"]);
      const cacheWrite = pickNumber(usageCandidate, ["cache_creation_input_tokens", "cacheWriteInputTokens", "cache_write", "cacheWrite"]);
      if (input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
        usage = {
          fresh: Math.max(0, (input ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0)),
          cacheWrite: cacheWrite ?? 0,
          cacheRead: cacheRead ?? 0,
          output: output ?? 0,
        };
      }
    }
    if (typeof value.text === "string" && value.text.length > 0 && (value.type === "text" || value.role === "assistant" || value.type === undefined)) {
      text = value.text;
    }
    if (Array.isArray(value.content)) {
      for (const part of value.content) {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") text = part.text;
      }
    }
    const calls = value.toolCalls ?? value.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (isRecord(call) && typeof call.name === "string") toolCalls.push({ name: call.name, input: call.input });
      }
    }
    if ((value.type === "tool_use" || value.type === "tool_call") && typeof value.name === "string") {
      toolCalls.push({ name: value.name, input: value.input });
    }
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      visit(JSON.parse(trimmed));
    } catch {
      // Not JSON: the CLI also prints human-readable lines. Keep it as text evidence.
      notes.push(`non-JSON line: ${trimmed.slice(0, 200)}`);
      if (text.length === 0) text = trimmed.slice(0, 2000);
    }
  }

  if (usage === undefined) {
    notes.push("no token usage found in `opencode run --format json` output; reporting zeros");
    usage = { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  }
  return { text, toolCalls, usage, notes };
}

function renderPrompt(messages: readonly ChatMessage[], tools: readonly ToolDescriptor[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") lines.push(message.text);
    else if (message.role === "assistant") lines.push(`[assistant] ${message.text}`);
    else lines.push(`[tool ${message.toolName ?? "?"}] ${message.text}`);
  }
  if (tools.length > 0) {
    lines.push(`\nAvailable tools: ${tools.map((tool) => tool.name).join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Headless `opencode run` driver.
 *
 * ASSUMPTIONS / LIMITATIONS (documented in `harness/README.md`):
 *  - one `complete()` == one `opencode run` invocation, so `turns` counts invocations;
 *  - the child runs against the *scratch directory as cwd* using the CLI's own tool set — the
 *    harness `ToolBox` cannot be injected into the CLI, so arm A is not turn-by-turn here;
 *  - the prompt is passed as a single positional argument;
 *  - `process.env` is inherited so the CLI can resolve its own auth (never logged).
 */
export function createOpenCodeCliDriver(opts: OpenCodeCliDriverOptions = {}): ModelDriver {
  const binary = opts.binary ?? "opencode";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return {
    id: `opencode:${opts.model ?? "default"}`,
    async complete(req: { messages: readonly ChatMessage[]; tools: readonly ToolDescriptor[]; signal?: AbortSignal }): Promise<ModelResponse> {
      const args = ["run", "--format", "json", "--standalone"];
      if (opts.model !== undefined) args.push("--model", opts.model);
      if (opts.agent !== undefined) args.push("--agent", opts.agent);
      args.push(renderPrompt(req.messages, req.tools));

      const { stdout } = await execFileAsync(binary, args, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      const parsed = parseOpenCodeJsonOutput(String(stdout));
      return { text: parsed.text, toolCalls: parsed.toolCalls, usage: parsed.usage };
    },
  };
}
