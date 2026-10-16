/**
 * Test helpers for the runner/arm unit tests (not a test file itself).
 *
 * OWNER: worker D1.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import type {
  ChatMessage,
  ModelDriver,
  ModelResponse,
  TaskDef,
  TokenUsage,
  ToolBox,
  ToolDescriptor,
} from "../types.ts";
import { createToolBox } from "../sandbox/index.ts";

const tempDirs: string[] = [];

/** Creates a temp directory that `cleanupTempDirs()` will remove. */
export async function tempDir(prefix = "opencode-harness-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
}

/** Writes a fixture tree: `{ "src/a.ts": "…" }`. */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

export function usage(fresh = 10, cacheRead = 100, output = 5): TokenUsage {
  return { fresh, cacheWrite: 0, cacheRead, output };
}

export interface RecordingDriver extends ModelDriver {
  readonly requests: { messages: readonly ChatMessage[]; tools: readonly ToolDescriptor[] }[];
}

/** A driver that replays canned responses and records every request it sees. */
export function replayDriver(responses: ModelResponse[], id = "fake-driver"): RecordingDriver {
  const queue = [...responses];
  const requests: RecordingDriver["requests"] = [];
  return {
    id,
    requests,
    async complete(req) {
      requests.push({ messages: [...req.messages], tools: req.tools });
      const next = queue.shift();
      if (next === undefined) throw new Error("replayDriver: no more canned responses");
      return next;
    },
  };
}

export function response(text: string, toolCalls: ModelResponse["toolCalls"] = [], tokenUsage = usage()): ModelResponse {
  return { text, toolCalls, usage: tokenUsage as TokenUsage };
}

export interface TestTaskOptions extends Partial<TaskDef> {
  verifyPassed?: boolean;
}

/** A minimal `TaskDef` for arm tests (no fixture is copied by these tests). */
export function testTask(options: TestTaskOptions = {}): TaskDef {
  const { verifyPassed = true, ...overrides } = options;
  return {
    id: "test-task",
    title: "test task",
    kind: "one-shot",
    fixture: ".",
    prompt: "do the thing",
    scriptPrompt: "write one script that does the thing",
    verify: async () => ({ passed: verifyPassed }),
    ...overrides,
  };
}

/** A toolbox over a fresh temp dir with optional fixture files. */
export async function testToolbox(files: Record<string, string> = {}, names?: readonly string[]): Promise<ToolBox> {
  const dir = await tempDir();
  await writeFiles(dir, files);
  return createToolBox({ dir, ...(names === undefined ? {} : { names }) });
}

export { createToolBox };
