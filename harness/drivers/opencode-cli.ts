/**
 * `opencode run` CLI driver — a REAL implementation.
 *
 * It shells out to `opencode run --format json` once per `complete()` call, in the current
 * working directory, and parses the JSON-lines stream that the CLI prints:
 *
 *   {"type":"text","timestamp":…,"sessionID":…,"part":{"type":"text","text":"…"}}
 *   {"type":"tool_use","timestamp":…,"sessionID":…,"part":{"type":"tool","tool":"read","input":{…}}}
 *   {"type":"step_finish","timestamp":…,"sessionID":…,"part":{"type":"step-finish","reason":…,"cost":…,
 *       "tokens":{"input":…,"output":…,"cache":{"read":…,"write":…}}}}
 *   {"type":"error",…,"error":{…}}
 *
 * WHAT IS PARSED (and what is not):
 *   * final text  — every `text` event's `part.text`, concatenated.
 *   * token usage — summed over `step_finish` events (`tokens.input` -> `fresh`,
 *     `tokens.cache.read` -> `cacheRead`, `tokens.cache.write` -> `cacheWrite`,
 *     `tokens.output` -> `output`). A snake_case `cache_read`/`cache_write` variant is
 *     accepted defensively. `cost` is summed into `costUsd` when the CLI reports it.
 *   * `tool_use` events are intentionally IGNORED: the CLI already ran those tools inside
 *     its own agent loop, so replaying them through the harness `ToolBox` would execute them
 *     twice. `complete()` therefore returns no tool calls, and the harness's arm-A loop stops
 *     after this turn — the CLI behaves as a one-shot black box.
 *
 * It does NOT invent usage: when no `step_finish` event is found, every token count is `0`.
 *
 * This driver is implemented and typechecked but is NOT exercised by this task: running it
 * needs a working `opencode` binary, a configured model and network access. It throws a clear
 * error when the binary is missing.
 */
import { spawnSync } from "node:child_process";
import type { ChatMessage, ModelDriver, ModelResponse, TokenUsage } from "../types.ts";

export interface OpenCodeCliDriverOptions {
  /** Passed to `opencode run --model <model>`. */
  model?: string;
  /** Passed to `opencode run --agent <agent>`. */
  agent?: string;
  /** Binary to spawn. Default `"opencode"`. */
  binary?: string;
}

const DEFAULT_BINARY = "opencode";
/** Hard ceiling so a wedged CLI cannot hang the harness forever. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

interface ParsedRun {
  text: string;
  usage: TokenUsage;
  errors: string[];
  sawJson: boolean;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(usage: TokenUsage, tokens: unknown): void {
  if (tokens === null || typeof tokens !== "object") return;
  const t = tokens as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;
  usage.fresh += num(t.input);
  usage.output += num(t.output);
  usage.cacheRead += num(cache.read ?? t.cache_read);
  usage.cacheWrite += num(cache.write ?? t.cache_write);
}

/** Parse the `--format json` stream. Exported for tests; never touches the network. */
export function parseOpenCodeRunOutput(stdout: string): ParsedRun {
  const usage: TokenUsage = { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const errors: string[] = [];
  let text = "";
  let costUsd: number | undefined;
  let sawJson = false;

  for (const raw of stdout.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawJson = true;
    const type = event.type;

    if (type === "text") {
      const part = event.part as Record<string, unknown> | undefined;
      if (part !== undefined && typeof part.text === "string") text += part.text;
      continue;
    }
    if (type === "step_finish") {
      const part = event.part as Record<string, unknown> | undefined;
      if (part !== undefined) {
        addUsage(usage, part.tokens);
        if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
          costUsd = (costUsd ?? 0) + part.cost;
        }
      }
      continue;
    }
    if (type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      errors.push(String(err?.message ?? err ?? "unknown error"));
      continue;
    }
    // Any other event (step_start, tool_use, reasoning, …) carries no information this
    // driver needs.
  }

  if (costUsd !== undefined) usage.costUsd = costUsd;
  return { text, usage, errors, sawJson };
}

function buildPrompt(messages: readonly ChatMessage[]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n\n");
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
        const names = m.toolCalls.map((c) => c.name).join(", ");
        return `assistant: ${m.text}\n[requested tools: ${names}]`;
      }
      if (m.role === "tool") return `tool(${m.toolName ?? "?"}): ${m.text}`;
      return `${m.role}: ${m.text}`;
    })
    .join("\n\n");
  const prompt = [system, conversation].filter((s) => s.length > 0).join("\n\n");
  return prompt.length > 0 ? prompt : "Continue.";
}

export function createOpenCodeCliDriver(opts: OpenCodeCliDriverOptions = {}): ModelDriver {
  const binary = opts.binary ?? DEFAULT_BINARY;

  return {
    id: `opencode-cli:${binary}`,

    async complete(req): Promise<ModelResponse> {
      const args = ["run", "--format", "json"];
      if (opts.model !== undefined) args.push("--model", opts.model);
      if (opts.agent !== undefined) args.push("--agent", opts.agent);
      args.push(buildPrompt(req.messages));

      const res = spawnSync(binary, args, {
        encoding: "utf8",
        maxBuffer: MAX_STDOUT_BYTES,
        timeout: RUN_TIMEOUT_MS,
      });

      if (res.error !== undefined && res.error !== null) {
        const code = (res.error as { code?: string }).code;
        const message = String((res.error as { message?: unknown }).message ?? res.error);
        if (code === "ENOENT" || /ENOENT|no such file/i.test(message)) {
          throw new Error(
            `opencode binary not found: "${binary}" (set { binary } or put opencode on PATH)`,
          );
        }
        throw new Error(`failed to spawn "${binary}": ${message}`);
      }

      const stdout = String(res.stdout ?? "");
      const stderr = String(res.stderr ?? "");
      const parsed = parseOpenCodeRunOutput(stdout);
      const status = res.status ?? -1;

      if (status !== 0) {
        const reason = parsed.errors.join("; ") || stderr.trim() || "no output";
        throw new Error(`opencode run exited ${status}: ${reason}`);
      }

      const text = parsed.sawJson ? parsed.text : stdout.trim();
      if (text.length === 0 && parsed.errors.length > 0) {
        throw new Error(`opencode run reported an error: ${parsed.errors.join("; ")}`);
      }

      return { text, toolCalls: [], usage: parsed.usage };
    },
  };
}
