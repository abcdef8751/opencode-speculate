import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import {
  createToolBox,
  executeScript,
  globToRegExp,
  resolveInside,
  tokenizeCommand,
  ToolBoxError,
} from "./index.ts";
import type { DecidePluginTool } from "./decide-port.ts";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-harness-sandbox-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
});

const stubDecide: DecidePluginTool = {
  name: "decide",
  description: "stub decide",
  input: { type: "object", properties: { state: {}, questions: {} }, required: ["state", "questions"] },
  output: { type: "object" },
  options: { namespace: "typesafe", codemode: true, pinned: true },
  async execute(input) {
    const questions = (input as { questions?: unknown }).questions;
    const id = Array.isArray(questions)
      ? String((questions[0] as { id?: unknown })?.id)
      : String((questions as { id?: unknown } | undefined)?.id);
    return {
      output: { id, mode: "noul", value: true, confidence: 0.9, modelId: "stub", latencyMs: 1, cached: false, escalate: false },
      content: "stub",
    };
  },
};

describe("confinement", () => {
  test("resolveInside rejects escapes and accepts inside paths", () => {
    const dir = "/tmp/opencode/scratch";
    expect(resolveInside(dir, "a/b.txt")).toBe("/tmp/opencode/scratch/a/b.txt");
    expect(resolveInside(dir, "./a.txt")).toBe("/tmp/opencode/scratch/a.txt");
    expect(() => resolveInside(dir, "../escape.txt")).toThrow(ToolBoxError);
    expect(() => resolveInside(dir, "/etc/passwd")).toThrow(ToolBoxError);
    expect(() => resolveInside(dir, "")).toThrow(ToolBoxError);
    expect(() => resolveInside(dir, 42)).toThrow(ToolBoxError);
  });

  test("tools refuse to touch files outside the scratch dir", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });
    await expect(box.call("read", { path: "../outside.txt" })).rejects.toThrow(ToolBoxError);
    await expect(box.call("write", { path: "/tmp/opencode/escape.txt", content: "x" })).rejects.toThrow(ToolBoxError);
  });

  test("unknown tool names are rejected and names honour the requested subset", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir, names: ["read", "nope"] });
    expect(box.names).toEqual(["read"]);
    expect(box.descriptors.map((d) => d.name)).toEqual(["read"]);
    await expect(box.call("write", { path: "a", content: "b" })).rejects.toThrow(/unavailable tool/);
  });
});

describe("file tools", () => {
  test("write / read / edit / glob / grep round trip", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });
    await box.call("write", { path: "src/hello.ts", content: "export const hello = 1\nexport const bye = 2\n" });
    await box.call("write", { path: "notes.md", content: "nothing to see\n" });

    expect(await box.call("read", { path: "src/hello.ts" })).toContain("hello = 1");

    const edited = await box.call("edit", { path: "src/hello.ts", find: "hello = 1", replace: "hello = 3" });
    expect(edited).toMatchObject({ ok: true, path: "src/hello.ts", replacements: 1 });
    expect(await box.call("read", { path: "src/hello.ts", offset: 1, limit: 1 })).toBe("export const hello = 3");

    expect(await box.call("glob", { pattern: "**/*.ts" })).toEqual({ files: ["src/hello.ts"], paths: ["src/hello.ts"], count: 1 });
    expect(await box.call("glob", { pattern: "*.md" })).toEqual({ files: ["notes.md"], paths: ["notes.md"], count: 1 });

    const found = (await box.call("grep", { pattern: "bye = \\d" })) as { matches: { path: string; line: number }[]; files: string[] };
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]!.path).toBe("src/hello.ts");
    expect(found.matches[0]!.line).toBe(2);
    expect(found.files).toEqual(["src/hello.ts"]);

    const literal = (await box.call("grep", { pattern: "hello = 3", literal: true })) as { matches: unknown[] };
    expect(literal.matches).toHaveLength(1);
  });

  test("edit keeps accepting oldString/newString aliases, and fails when find is absent/empty/ambiguous", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });
    await box.call("write", { path: "a.txt", content: "x x" });
    await expect(box.call("edit", { path: "a.txt", find: "zzz", replace: "y" })).rejects.toThrow(/not found/);
    await expect(box.call("edit", { path: "a.txt", find: "", replace: "y" })).rejects.toThrow(/must not be empty/);
    await expect(box.call("edit", { path: "a.txt", find: "x", replace: "y" })).rejects.toThrow(/not unique/);
    await expect(box.call("edit", { path: "a.txt", oldString: "x", newString: "y", replaceAll: true })).resolves.toMatchObject({
      replacements: 2,
    });
    expect(await box.call("read", { path: "a.txt" })).toBe("y y");
  });

  test("read truncates oversized content", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir, maxOutputBytes: 10 });
    await box.call("write", { path: "big.txt", content: "0123456789ABCDEF" });
    expect(await box.call("read", { path: "big.txt" })).toContain("[truncated at 10 characters]");
  });
});

describe("shell", () => {
  test("runs argv without a shell, reports exit codes, and reports failures", async () => {
    const dir = await scratch();
    await fs.writeFile(path.join(dir, "hello.txt"), "hi", "utf8");
    const box = createToolBox({ dir });

    const ls = (await box.call("shell", { command: "ls -1" })) as { ok: boolean; stdout: string; exitCode: number };
    expect(ls.ok).toBe(true);
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain("hello.txt");

    // non-zero exit is a reportable result (ratified shape carries `exitCode`)
    const bad = (await box.call("shell", { command: "ls", args: ["/definitely/missing"] })) as { ok: boolean; exitCode: number };
    expect(bad.ok).toBe(false);
    expect(bad.exitCode).not.toBe(0);

    // no shell interpolation: a binary that does not exist cannot be run at all
    await expect(box.call("shell", { command: "definitely-not-a-binary" })).rejects.toThrow(ToolBoxError);
  });

  test("tokenizeCommand splits argv-style with quotes and never involves a shell", () => {
    expect(tokenizeCommand("ls -la")).toEqual(["ls", "-la"]);
    expect(tokenizeCommand('git commit -m "hello world"')).toEqual(["git", "commit", "-m", "hello world"]);
    expect(tokenizeCommand("a ''")).toEqual(["a", ""]);
    expect(() => tokenizeCommand('bad "quote')).toThrow(ToolBoxError);
    expect(() => tokenizeCommand("   ")).toThrow(ToolBoxError);
  });

  test("globToRegExp handles ** and braces", () => {
    expect(globToRegExp("**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("src/*.{ts,tsx}").test("src/a.tsx")).toBe(true);
  });
});

describe("code mode sandbox", () => {
  test("scripts see the toolbox tools and hand values back", async () => {
    const dir = await scratch();
    await fs.writeFile(path.join(dir, "data.txt"), "payload", "utf8");
    const box = createToolBox({ dir });

    const result = await executeScript({
      toolbox: box,
      code: `
        const text = await tools.read({ path: "data.txt" });
        console.log("read", text);
        return { text };
      `,
      limits: { timeoutMs: 5000 },
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ text: "payload" });
    expect(result.logs).toEqual(["read payload"]);
    expect(result.toolCalls).toEqual(["read"]);
    expect(result.toolFailures).toBe(0);
  });

  test("decide is mounted at tools.typesafe.decide and its output crosses back", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });
    const result = await executeScript({
      toolbox: box,
      decide: stubDecide,
      code: `
        const d = await tools.typesafe.decide({ state: "x", questions: { mode: "noul", id: "q1", criteria: { true: "y", false: "n" } } });
        if (d.escalate) { console.log("escalated"); }
        return d.value;
      `,
      limits: { timeoutMs: 5000 },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(result.toolCalls).toEqual(["typesafe.decide"]);
  });

  test("a missing tool fails at call time and a tool error is catchable, counted as a tool failure", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });

    const absent = await executeScript({ toolbox: box, code: `return await tools.nope({});`, limits: { timeoutMs: 5000 } });
    expect(absent.ok).toBe(false);
    expect(absent.errorKind).toBe("UnknownTool");

    const failing = await executeScript({
      toolbox: box,
      code: `try { await tools.read({ path: "missing.txt" }); return "read"; } catch (e) { return "caught:" + e.message; }`,
      limits: { timeoutMs: 5000 },
    });
    expect(failing.ok).toBe(true);
    expect(String(failing.value)).toContain("caught:");
    expect(failing.toolFailures).toBe(1);
    expect(failing.toolCalls).toEqual(["read"]);
  });

  test("parse errors are data, and the sandbox exposes no network", async () => {
    const dir = await scratch();
    const box = createToolBox({ dir });
    const parsed = await executeScript({ toolbox: box, code: "this is not js", limits: { timeoutMs: 5000 } });
    expect(parsed.ok).toBe(false);
    expect(parsed.errorKind).toBe("ParseError");

    const net = await executeScript({
      toolbox: box,
      code: `return { fetch: typeof fetch, process: typeof process };`,
      limits: { timeoutMs: 5000 },
    });
    expect(net.ok).toBe(true);
    expect(net.value).toEqual({ fetch: "undefined", process: "undefined" });
  });

  test("the CodeMode runtime's own `search` global discovers the sandbox tools", async () => {
    const box = createToolBox({ dir: await scratch(), names: ["read", "write"] });
    const result = await executeScript({
      toolbox: box,
      decide: stubDecide,
      code: `const a = await search({ query: "read" }); const b = await search({ query: "decide" }); return { a, b };`,
      limits: { timeoutMs: 5000 },
    });
    expect(result.ok).toBe(true);
    const value = result.value as { a: { items: { path: string }[] }; b: { items: { path: string }[] } };
    const paths = [...(value.a.items ?? []), ...(value.b.items ?? [])].map((item) => item.path);
    expect(paths).toContain("tools.read");
    expect(paths).toContain("tools.typesafe.decide");
    expect(paths).not.toContain("tools.write"); // excluded by `names`
  });

  test("tool call limit is enforced as a script failure", async () => {
    const dir = await scratch();
    await fs.writeFile(path.join(dir, "a.txt"), "a", "utf8");
    const box = createToolBox({ dir });
    const result = await executeScript({
      toolbox: box,
      code: `await tools.read({ path: "a.txt" }); return 1;`,
      limits: { maxToolCalls: 0, timeoutMs: 5000 },
    });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("ToolCallLimitExceeded");
  });
});
