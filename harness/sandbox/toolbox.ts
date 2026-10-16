/**
 * The harness `ToolBox`: six fs/shell built-ins confined to a per-run scratch directory.
 *
 * This is *measurement scaffolding*, not a security boundary. It exists so the three arms can be
 * compared against the same, deterministic tool surface. See `harness/README.md` for the honest
 * limitations (TOCTOU, symlink races, no seccomp, no mount isolation).
 *
 * Two shapes are produced from the same implementations:
 *   - `descriptors` / `call()` for arm A (the model calls tools turn by turn);
 *   - the CodeMode tool tree (built in `./codemode.ts`) for arms B/C.
 *
 * OWNER: worker D1. Do not edit outside `harness/sandbox/**`.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Json, ToolBox, ToolDescriptor } from "../types.ts";

const execFileAsync = promisify(execFile);

/** Default cap on a single tool result, so a script cannot dump a huge file into the transcript. */
export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

/** Default shell timeout. A run must never hang on a wedged child process. */
export const DEFAULT_SHELL_TIMEOUT_MS = 20_000;

/** The six built-ins the `builtins-flip` feature toggles, in a stable order. */
export const TOOLBOX_TOOL_NAMES = ["read", "grep", "glob", "shell", "edit", "write"] as const;
export type ToolBoxToolName = (typeof TOOLBOX_TOOL_NAMES)[number];

export interface ToolBoxOptions {
  /** Scratch directory the tools are confined to. Must exist. */
  dir: string;
  /** Restrict the visible tools (e.g. `TaskDef.tools`). Defaults to all six, in a stable order. */
  names?: readonly string[];
  maxOutputBytes?: number;
  shellTimeoutMs?: number;
}

export class ToolBoxError extends Error {
  override readonly name = "ToolBoxError";
}

/* ------------------------------------------------------------------ *
 * Path confinement
 * ------------------------------------------------------------------ */

/**
 * Resolve `relative` inside `dir`, rejecting escapes (`..`, absolute paths outside, empty).
 * The check is textual; it does not defeat symlink races (see README).
 */
export function resolveInside(dir: string, relative: unknown): string {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new ToolBoxError(`expected a non-empty path string, got ${JSON.stringify(relative)}`);
  }
  const root = path.resolve(dir);
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolBoxError(`path escapes the scratch directory: ${relative}`);
  }
  return abs;
}

/**
 * Stronger, still best-effort check: the deepest *existing* ancestor of `abs` must resolve
 * (through symlinks) to a location inside `dir`. Catches the common symlink escape.
 */
async function assertRealInside(dir: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(dir));
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new ToolBoxError(`path escapes the scratch directory through a symlink: ${abs}`);
      }
      return;
    } catch (error) {
      if (error instanceof ToolBoxError) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return; // ran out of ancestors; prefix check already passed
      probe = parent;
    }
  }
}

async function resolveForWrite(dir: string, relative: unknown): Promise<string> {
  const abs = resolveInside(dir, relative);
  const parent = path.dirname(abs);
  await assertRealInside(dir, parent);
  return abs;
}

async function resolveForRead(dir: string, relative: unknown): Promise<string> {
  const abs = resolveInside(dir, relative);
  await assertRealInside(dir, abs);
  return abs;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated at ${max} characters]`;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolBoxError(`expected an object input, got ${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    if (required) throw new ToolBoxError(`missing required field "${key}"`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolBoxError(`field "${key}" must be a string`);
  return value;
}

function optNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolBoxError(`field "${key}" must be a finite number`);
  }
  return value;
}

/** Minimal structural view of a `Dirent` — Node's typings vary the generic name type. */
interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

async function* walk(root: string): AsyncGenerator<string> {
  const skip = new Set([".git", "node_modules", ".tmp"]);
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop() ?? "";
    let entries: readonly DirEntry[];
    try {
      entries = (await fs.readdir(path.join(root, relativeDir), { withFileTypes: true })) as unknown as readonly DirEntry[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
      if (entry.isDirectory()) {
        if (skip.has(name)) continue;
        stack.push(relative);
      } else if (entry.isFile()) {
        yield relative;
      }
    }
  }
}

/** Translate a small glob subset (`*`, `**`, `?`, `{a,b}`) into an anchored regex. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const body = pattern.slice(i + 1, close);
        out += `(?:${body.split(",").map(escapeRegExp).join("|")})`;
        i = close;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split an argv-style command line without a shell: quotes group, no expansion, no metachars. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (quote !== undefined) throw new ToolBoxError("unbalanced quote in command");
  if (started || current.length > 0) tokens.push(current);
  if (tokens.length === 0) throw new ToolBoxError("empty command");
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Descriptors
 * ------------------------------------------------------------------ */

const INPUT_SCHEMAS: Record<ToolBoxToolName, Record<string, unknown>> = {
  read: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the scratch directory." },
      offset: { type: "number", description: "1-based first line to return." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (or literal text with `literal: true`)." },
      path: { type: "string", description: "Optional subdirectory to search." },
      include: { type: "string", description: "Optional glob filter on the relative path." },
      literal: { type: "boolean" },
      ignoreCase: { type: "boolean" },
      maxResults: { type: "number" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  glob: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob (`*`, `**`, `?`, `{a,b}`)." },
      path: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  shell: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Command line. Tokenised without a shell when `args` is omitted (no pipes, redirection or expansion); pass `args` (or an argv array) for exact arguments.",
      },
      args: { type: "array", items: { type: "string" } },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  edit: {
    type: "object",
    properties: {
      path: { type: "string" },
      find: { type: "string", description: "Exact text to replace." },
      replace: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence (default: the single occurrence, error if ambiguous)." },
    },
    required: ["path", "find", "replace"],
    additionalProperties: false,
  },
  write: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const DESCRIPTIONS: Record<ToolBoxToolName, string> = {
  read: "Read a text file from the scratch directory. Returns the file text.",
  grep: "Search file contents in the scratch directory. Returns `{ matches, files }`.",
  glob: "List files matching a glob in the scratch directory. Returns `{ files, paths }`.",
  shell: "Run a command (argv, no shell) in the scratch directory. Returns `{ stdout, stderr, exitCode }`.",
  edit: "Replace `find` with `replace` in a file in the scratch directory.",
  write: "Write a file in the scratch directory.",
};

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

interface ImplContext {
  dir: string;
  maxOutputBytes: number;
  shellTimeoutMs: number;
}

type ToolImpl = (input: unknown, ctx: ImplContext, signal?: AbortSignal) => Promise<Json>;

const impls: Record<ToolBoxToolName, ToolImpl> = {
  async read(input, ctx) {
    const record = asRecord(input);
    const abs = await resolveForRead(ctx.dir, str(record, "path"));
    const text = await fs.readFile(abs, "utf8");
    const offset = optNumber(record, "offset");
    const limit = optNumber(record, "limit");
    let body = text;
    if (offset !== undefined || limit !== undefined) {
      const lines = text.split("\n");
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit === undefined ? lines.length : start + limit;
      body = lines.slice(start, end).join("\n");
    }
    return truncate(body, ctx.maxOutputBytes);
  },

  async grep(input, ctx) {
    const record = asRecord(input);
    const patternText = str(record, "pattern")!;
    const base = record.path === undefined ? "" : str(record, "path")!;
    const rootAbs = await resolveForRead(ctx.dir, base === "" ? "." : base);
    await assertRealInside(ctx.dir, rootAbs);
    const include = record.include === undefined ? undefined : globToRegExp(str(record, "include")!);
    const flags = record.ignoreCase === true ? "i" : "";
    const regex = new RegExp(record.literal === true ? escapeRegExp(patternText) : patternText, flags);
    const maxResults = optNumber(record, "maxResults") ?? 200;
    const matches: Json[] = [];
    const files: string[] = [];
    for await (const relative of walk(rootAbs)) {
      if (include !== undefined && !include.test(relative)) continue;
      const text = await fs.readFile(path.join(rootAbs, relative), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const prefix = base === "" ? "" : `${base.replace(/\/$/, "")}/`;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (regex.test(line)) {
          matches.push({ path: `${prefix}${relative}`, line: i + 1, text: line.slice(0, 500) });
          if (!files.includes(`${prefix}${relative}`)) files.push(`${prefix}${relative}`);
          if (matches.length >= maxResults) return { matches, files, count: matches.length };
        }
      }
    }
    return { matches, files, count: matches.length };
  },

  async glob(input, ctx) {
    const record = asRecord(input);
    const regex = globToRegExp(str(record, "pattern")!);
    const base = record.path === undefined ? "" : str(record, "path")!;
    const rootAbs = await resolveForRead(ctx.dir, base === "" ? "." : base);
    const found: string[] = [];
    for await (const relative of walk(rootAbs)) {
      const baseName = relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
      if (regex.test(relative) || regex.test(baseName)) {
        found.push(base === "" ? relative : `${base.replace(/\/$/, "")}/${relative}`);
      }
    }
    found.sort();
    return { files: found, paths: found, count: found.length };
  },

  async shell(input, ctx, signal) {
    const record = asRecord(input);
    const commandField = record.command;
    let file: string;
    let args: string[];
    if (Array.isArray(commandField)) {
      const argv = commandField.map((value) => {
        if (typeof value !== "string") throw new ToolBoxError("command[] entries must be strings");
        return value;
      });
      if (argv.length === 0) throw new ToolBoxError("empty command");
      file = argv[0]!;
      args = argv.slice(1);
    } else if (typeof commandField === "string") {
      if (record.args !== undefined) {
        if (!Array.isArray(record.args)) throw new ToolBoxError("args must be an array of strings");
        file = commandField;
        args = record.args.map((value) => {
          if (typeof value !== "string") throw new ToolBoxError("args[] entries must be strings");
          return value;
        });
      } else {
        const tokens = tokenizeCommand(commandField);
        file = tokens[0]!;
        args = tokens.slice(1);
      }
    } else {
      throw new ToolBoxError("command must be a string or an array of strings");
    }

    const timeout = optNumber(record, "timeoutMs") ?? ctx.shellTimeoutMs;
    const argv = [file, ...args];
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: ctx.dir,
        timeout,
        maxBuffer: Math.max(ctx.maxOutputBytes, 1_048_576),
        shell: false,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        ok: true,
        command: argv.join(" "),
        stdout: truncate(String(stdout), ctx.maxOutputBytes),
        stderr: truncate(String(stderr), ctx.maxOutputBytes),
        exitCode: 0,
        text: truncate(String(stdout), ctx.maxOutputBytes),
      };
    } catch (error) {
      const err = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean; message?: string };
      // A spawned command that exits non-zero is a normal, reportable result (the ratified shape
      // carries `exitCode`). "Could not run it at all" (ENOENT/EACCES), a timeout and a signal
      // kill are thrown instead.
      if (typeof err.code === "number" && err.killed !== true) {
        const stdout = truncate(String(err.stdout ?? ""), ctx.maxOutputBytes);
        const stderr = truncate(String(err.stderr ?? ""), ctx.maxOutputBytes);
        return {
          ok: false,
          command: argv.join(" "),
          stdout,
          stderr,
          exitCode: err.code,
          text: stderr.length > 0 ? stderr : stdout,
        };
      }
      const detail = [
        `command failed: ${argv.join(" ")}`,
        err.killed === true ? "(killed: timeout or signal)" : undefined,
        typeof err.code === "string" ? `code=${err.code}` : undefined,
        err.stderr ? `stderr=${truncate(String(err.stderr), 2000)}` : undefined,
        err.message,
      ].filter(Boolean);
      throw new ToolBoxError(detail.join(" | "));
    }
  },

  async edit(input, ctx) {
    const record = asRecord(input);
    const abs = await resolveForWrite(ctx.dir, str(record, "path"));
    // Ratified shape: `{ path, find, replace }`. `oldString`/`newString` stay accepted as aliases.
    const find = str(record, "find", false) ?? str(record, "oldString", false);
    const replacement = str(record, "replace", false) ?? str(record, "newString", false);
    if (find === undefined || replacement === undefined) {
      throw new ToolBoxError("edit requires `find` and `replace` (aliases: oldString/newString)");
    }
    if (find === "") throw new ToolBoxError("`find` must not be empty");
    const text = await fs.readFile(abs, "utf8");
    const occurrences = text.split(find).length - 1;
    if (occurrences === 0) throw new ToolBoxError(`find text not found in ${String(record.path)}`);
    const replaceAll = record.replaceAll === true;
    if (!replaceAll && occurrences > 1) {
      throw new ToolBoxError(`find text is not unique in ${String(record.path)} (${occurrences} matches)`);
    }
    const next = replaceAll ? text.split(find).join(replacement) : text.replace(find, replacement);
    await fs.writeFile(abs, next, "utf8");
    const replacements = replaceAll ? occurrences : 1;
    return {
      ok: true,
      path: String(record.path),
      replacements,
      text: `edited ${String(record.path)} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
    };
  },

  async write(input, ctx) {
    const record = asRecord(input);
    const abs = await resolveForWrite(ctx.dir, str(record, "path"));
    const content = str(record, "content", false) ?? "";
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return { ok: true, path: String(record.path), bytes, text: `wrote ${String(record.path)} (${bytes} bytes)` };
  },
};

/** Creates a `ToolBox` confined to `opts.dir`. */
export function createToolBox(opts: ToolBoxOptions): ToolBox {
  const dir = path.resolve(opts.dir);
  const requested = opts.names ?? TOOLBOX_TOOL_NAMES;
  const names = TOOLBOX_TOOL_NAMES.filter((name) => requested.includes(name));
  const ctx: ImplContext = {
    dir,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    shellTimeoutMs: opts.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
  };
  const descriptors: ToolDescriptor[] = names.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    input: INPUT_SCHEMAS[name],
  }));

  return {
    dir,
    descriptors,
    names,
    async call(name: string, input: unknown, signal?: AbortSignal): Promise<Json> {
      if (!names.includes(name as ToolBoxToolName)) {
        throw new ToolBoxError(`unknown or unavailable tool "${name}" (available: ${names.join(", ")})`);
      }
      return impls[name as ToolBoxToolName](input, ctx, signal);
    },
  };
}
