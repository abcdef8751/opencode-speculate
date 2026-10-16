/**
 * The Code Mode side of the sandbox: builds the `tools.*` tree (the six built-ins plus
 * `typesafe.decide`) and executes a script, returning a plain-data result.
 *
 * OWNER: worker D1 (`harness/sandbox/**`).
 */

import { CodeMode, Namespace, Tool as CMTool } from "@opencode/codemode";
import { Effect } from "effect";
import type { Json, ToolBox } from "../types.ts";
import { DECIDE_NAMESPACE, DECIDE_TOOL_NAME, type DecidePluginTool } from "./decide-port.ts";

export interface ScriptLimits {
  timeoutMs: number;
  maxToolCalls: number;
  maxOutputBytes: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  timeoutMs: 30_000,
  maxToolCalls: 200,
  maxOutputBytes: 200_000,
};

export interface ScriptExecution {
  ok: boolean;
  value?: Json;
  errorKind?: string;
  errorMessage?: string;
  logs: string[];
  toolCalls: string[];
  toolFailures: number;
  truncated: boolean;
  warnings: string[];
}

/** A tool call observed through Code Mode hooks (input is not part of `ArmResult`, used for logs). */
export interface ObservedToolCall {
  name: string;
  input: unknown;
  status: "success" | "failure" | "interrupted";
}

export interface BuildToolTreeOptions {
  toolbox: ToolBox;
  /** The §1 plugin tool. Mounted at `tools.<DECIDE_NAMESPACE>.decide`. */
  decide?: DecidePluginTool | undefined;
}

export interface BuiltToolTree {
  tools: Record<string, unknown>;
  warnings: string[];
}

function jsonSchema(value: Record<string, unknown>): CMTool.JsonSchema {
  return value as CMTool.JsonSchema;
}

function fromToolBox(toolbox: ToolBox, name: string): CMTool.Tool {
  const descriptor = toolbox.descriptors.find((entry) => entry.name === name);
  if (descriptor === undefined) {
    throw new Error(`toolbox exposes no descriptor for "${name}"`);
  }
  return CMTool.make({
    description: descriptor.description,
    input: descriptor.input,
    output: { description: "JSON result of the tool call." },
    execute: (input: unknown) =>
      Effect.promise(async () => {
        const result = await toolbox.call(name, input);
        return result;
      }),
  });
}

/**
 * Builds the `tools` object handed to `CodeMode.make`. Arm B uses the file/shell tools; arm C
 * additionally mounts the decide runtime under `typesafe.decide`.
 */
export function buildToolTree(opts: BuildToolTreeOptions): BuiltToolTree {
  const warnings: string[] = [];
  const tools: Record<string, unknown> = {};
  for (const name of opts.toolbox.names) {
    tools[name] = fromToolBox(opts.toolbox, name);
  }
  if (opts.decide !== undefined) {
    const namespace = opts.decide.options?.namespace;
    if (namespace !== undefined && namespace !== DECIDE_NAMESPACE) {
      warnings.push(
        `decide tool declares namespace "${namespace}", expected "${DECIDE_NAMESPACE}"; mounting at tools.${DECIDE_NAMESPACE}.decide anyway`,
      );
    }
    const decide = CMTool.make({
      description: opts.decide.description,
      input: jsonSchema(opts.decide.input),
      output: jsonSchema(opts.decide.output),
      execute: (input: unknown) =>
        Effect.promise(async () => {
          const result = await opts.decide!.execute(input);
          return (result.output ?? null) as unknown;
        }),
    });
    tools[DECIDE_NAMESPACE] = Namespace.make({
      description: "Type-safe judgements (the decide tool).",
      tools: { [DECIDE_TOOL_NAME]: decide },
    });
  }
  return { tools, warnings };
}

export interface ExecuteScriptOptions extends BuildToolTreeOptions {
  code: string;
  limits?: Partial<ScriptLimits>;
  onToolCall?: (call: ObservedToolCall) => void;
}

/**
 * Executes one Code Mode program over the sandbox tool tree. Program failures are data
 * (`ok: false`), never thrown.
 */
export async function executeScript(opts: ExecuteScriptOptions): Promise<ScriptExecution> {
  const limits = { ...DEFAULT_SCRIPT_LIMITS, ...opts.limits };
  const built = buildToolTree(opts);
  let toolFailures = 0;
  const runtime = CodeMode.make({
    tools: built.tools,
    limits: {
      timeoutMs: limits.timeoutMs,
      maxToolCalls: limits.maxToolCalls,
      maxOutputBytes: limits.maxOutputBytes,
    },
    hooks: {
      "tool.after": (call: { name: string; input?: unknown }, result: { status: "success" | "failure" | "interrupted" }) =>
        Effect.sync(() => {
          if (result.status === "failure") toolFailures += 1;
          opts.onToolCall?.({ name: call.name, input: call.input, status: result.status });
        }),
    },
  } as unknown as CodeMode.Options);

  const result = await Effect.runPromise(runtime.execute(opts.code));
  const toolCalls = result.toolCalls.map((call) => call.name);
  const logs = [...(result.logs ?? [])];
  const warnings = [...built.warnings];
  const truncated = result.truncated === true;
  if (result.ok) {
    for (const warning of result.warnings ?? []) {
      warnings.push(`${warning.kind}: ${warning.message}`);
    }
  }
  if (result.ok) {
    return {
      ok: true,
      value: result.value as Json,
      logs,
      toolCalls,
      toolFailures,
      truncated,
      warnings,
    };
  }

  return {
    ok: false,
    errorKind: result.error.kind,
    errorMessage: result.error.message,
    logs,
    toolCalls,
    toolFailures,
    truncated,
    warnings,
  };
}

/** Code Mode diagnostic kinds that count as script failures (parse / unsupported / limit). */
export const SCRIPT_FAILURE_KINDS = [
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "ExecutionFailure",
] as const;

/**
 * `ArmResult.scriptFailures`: one point per failed Code Mode execution, plus any parse-shaped
 * warning the program emitted, i.e. the diagnostics a model would have to fix and retry.
 */
export function calculateScriptFailures(execution: ScriptExecution): number {
  const parseWarnings = execution.warnings.filter((warning) => /^(ParseError|UnsupportedSyntax):/.test(warning)).length;
  return (execution.ok ? 0 : 1) + parseWarnings;
}
