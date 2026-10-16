/**
 * D2 driver tests. Offline and deterministic — no network, no real model, no Code Mode
 * execution.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, ModelDriver, ToolDescriptor } from "../types.ts";
import { TASKS } from "../tasks/index.ts";
import type { TaskWithJudgeAnswers } from "../tasks/util.ts";
import { createFakeJudge } from "./fake-judge.ts";
import {
  MOCK_ARM_A_WRITES,
  MOCK_DECIDE_QUESTION_ID,
  MOCK_PROGRAMS,
  createMockDriver,
  detectArm,
} from "./mock.ts";
import { createOpenCodeCliDriver, parseOpenCodeRunOutput } from "./opencode-cli.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TMP_ROOT = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * fake judge
 * ------------------------------------------------------------------ */

describe("createFakeJudge", () => {
  const request = {
    state: "some state",
    questions: {
      a: { type: "noul" as const },
      b: { type: "choice" as const, criteria: { yes: "yes please", no: "no thanks" } },
      c: { type: "score" as const },
    },
  };

  test("sets modelId and answers from the script", async () => {
    const judge = createFakeJudge({
      a: { noul: 0.2 },
      b: { choice: "no" },
      c: { score: 3 },
    });
    expect(judge.modelId).toBe("fake-judge");
    const res = await judge.systemOne(request);
    expect(res.model).toBe("fake-judge");
    expect(res.answers.a).toEqual({ type: "noul", noul: 0.2, confidence: 0.9 });
    expect(res.answers.b).toEqual({ type: "choice", choice: "no", confidence: 0.9 });
    expect(res.answers.c).toEqual({ type: "score", score: 3, confidence: 0.9 });
    expect(res.usage).toEqual({ input_tokens: expect.any(Number), output_tokens: 24 });
  });

  test("applies documented defaults (noul 0.9, choice = first criterion key, score 0, confidence 0.9)", async () => {
    const judge = createFakeJudge({ a: {}, b: {}, c: {} });
    const res = await judge.systemOne(request);
    expect(res.answers.a?.noul).toBe(0.9);
    expect(res.answers.b?.choice).toBe("yes");
    expect(res.answers.c?.score).toBe(0);
    expect(res.answers.a?.confidence).toBe(0.9);
  });

  test("honours a scripted confidence", async () => {
    const judge = createFakeJudge({ a: { noul: 0.5, confidence: 0.1 } });
    const res = await judge.systemOne({ state: "x", questions: { a: { type: "noul" } } });
    expect(res.answers.a?.confidence).toBe(0.1);
  });

  test("throws for an id that is not in the script", async () => {
    const judge = createFakeJudge({ a: {} });
    await expect(judge.systemOne(request)).rejects.toThrow(/no scripted answer for question id "b"/);
  });

  test("records every request in an inspectable log and can be reset", async () => {
    const judge = createFakeJudge({ a: {}, b: {}, c: {} });
    expect(judge.requests.length).toBe(0);
    await judge.systemOne(request);
    await judge.systemOne({ state: "again", questions: { a: { type: "noul" } } });
    expect(judge.requests.length).toBe(2);
    expect(judge.requests[0]).toBe(request);
    expect(judge.requests[1]?.state).toBe("again");
    judge.reset();
    expect(judge.requests.length).toBe(0);
  });

  test("is deterministic given the same script", async () => {
    const script = { a: { noul: 0.33 }, b: { choice: "no" }, c: { score: 2 } };
    const first = await createFakeJudge(script).systemOne(request);
    const second = await createFakeJudge(script).systemOne(request);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

/* ------------------------------------------------------------------ *
 * mock driver
 * ------------------------------------------------------------------ */

const CONTEXT_TOOLS: ToolDescriptor[] = ["read", "grep", "glob", "write"].map((name) => ({
  name,
  description: `${name} something`,
  input: { type: "object" },
}));

const SCRIPT_TOOLS: ToolDescriptor[] = [
  { name: "search", description: "discover", input: { type: "object" } },
  { name: "read", description: "read", input: { type: "object" } },
  { name: "write", description: "write", input: { type: "object" } },
];

const SCRIPT_TOOLS_WITH_DECIDE: ToolDescriptor[] = [
  ...SCRIPT_TOOLS,
  { name: "typesafe.decide", description: "decide", input: { type: "object" } },
];

const armAMessages = (taskId: string): ChatMessage[] => [
  { role: "system", text: `Task: ${taskId}` },
  { role: "user", text: `Please complete the ${taskId} task.` },
];

const scriptMessages = (taskId: string, withDecide: boolean): ChatMessage[] => [
  { role: "system", text: `Task: ${taskId}` },
  {
    role: "user",
    text: withDecide
      ? "Write one Code Mode program that uses tools.typesafe.decide and handles escalate."
      : "Write one Code Mode program that does the whole job in one shot.",
  },
];

describe("detectArm", () => {
  test("uses the tool list and falls back to the prompt text", () => {
    expect(detectArm(CONTEXT_TOOLS, "read the files")).toBe("A");
    expect(detectArm(SCRIPT_TOOLS, "write a script")).toBe("B");
    expect(detectArm(SCRIPT_TOOLS_WITH_DECIDE, "write a script")).toBe("C");
    expect(detectArm([], "Write ONE Code Mode program (JavaScript)")).toBe("B");
    expect(detectArm([], "call tools.typesafe.decide(...) for this")).toBe("C");
  });
});

describe("createMockDriver", () => {
  test("is deterministic across two instances with the same seed", async () => {
    const a = createMockDriver({ seed: 7 });
    const b = createMockDriver({ seed: 7 });
    const reqA = { messages: armAMessages("log-triage"), tools: CONTEXT_TOOLS, maxTurns: 9 };
    const reqB = { messages: scriptMessages("log-triage", true), tools: SCRIPT_TOOLS_WITH_DECIDE };
    const first = [await a.complete(reqA), await a.complete(reqB)];
    const second = [await b.complete(reqA), await b.complete(reqB)];
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("a different seed changes the synthetic usage (but not the tool calls)", async () => {
    const one = await createMockDriver({ seed: 1 }).complete({
      messages: armAMessages("fix-median"),
      tools: CONTEXT_TOOLS,
    });
    const two = await createMockDriver({ seed: 2 }).complete({
      messages: armAMessages("fix-median"),
      tools: CONTEXT_TOOLS,
    });
    expect(JSON.stringify(one.toolCalls)).toBe(JSON.stringify(two.toolCalls));
    expect(JSON.stringify(one.usage)).not.toBe(JSON.stringify(two.usage));
  });

  test("arm A emits one tool call per turn and stops with a final text answer", async () => {
    const driver: ModelDriver = createMockDriver({ seed: 3 });
    let messages: ChatMessage[] = armAMessages("log-triage");
    const calls: string[] = [];
    for (let turn = 0; turn < 20; turn++) {
      const res = await driver.complete({ messages, tools: CONTEXT_TOOLS });
      if (res.toolCalls.length === 0) {
        expect(res.text.length).toBeGreaterThan(0);
        break;
      }
      const call = res.toolCalls[0] as { name: string; input: unknown };
      calls.push(call.name);
      messages = [
        ...messages,
        { role: "assistant", text: "", toolCalls: [{ name: call.name, input: call.input }] },
        { role: "tool", text: "ok", toolName: call.name },
      ];
    }
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("glob");
    expect(calls.every((n) => CONTEXT_TOOLS.some((t) => t.name === n))).toBe(true);
  });

  test("arm A respects maxTurns", async () => {
    const driver = createMockDriver();
    const res = await driver.complete({
      messages: [
        ...armAMessages("log-triage"),
        { role: "assistant", text: "", toolCalls: [{ name: "glob", input: {} }] },
        { role: "tool", text: "ok", toolName: "glob" },
      ],
      tools: CONTEXT_TOOLS,
      maxTurns: 1,
    });
    expect(res.toolCalls).toEqual([]);
    expect(res.text.length).toBeGreaterThan(0);
  });

  test("arms B/C emit a syntactically valid, tool-using program for every task", async () => {
    for (const task of TASKS) {
      for (const [arm, withDecide, tools] of [
        ["B", false, SCRIPT_TOOLS],
        ["C", true, SCRIPT_TOOLS_WITH_DECIDE],
      ] as const) {
        const res = await createMockDriver().complete({
          messages: scriptMessages(task.id, withDecide),
          tools,
        });
        expect(res.text.length).toBeGreaterThan(0);
        expect(res.text).toContain("tools.");
        // Parse-only check: compile the program body inside an async IIFE. Never executed.
        expect(() =>
          new Function("tools", "console", `return (async () => {\n${res.text}\n})();`),
        ).not.toThrow();
        if (arm === "C") {
          expect(res.text).toContain("tools.typesafe.decide");
          expect(res.text).toContain("d.escalate");
          expect(res.text).toContain("break");
        } else {
          expect(res.text).not.toContain("tools.typesafe.decide");
        }
      }
    }
  });

  test("script arms are single-shot (a second turn produces nothing)", async () => {
    const driver = createMockDriver();
    const first = await driver.complete({
      messages: scriptMessages("fix-median", false),
      tools: SCRIPT_TOOLS,
    });
    expect(first.text.length).toBeGreaterThan(0);
    const second = await driver.complete({
      messages: [...scriptMessages("fix-median", false), { role: "assistant", text: first.text }],
      tools: SCRIPT_TOOLS,
    });
    expect(second.text).toBe("");
    expect(second.toolCalls).toEqual([]);
  });

  test("programs overrides replace the canned program by task id", async () => {
    const driver = createMockDriver({ programs: { "log-triage": { B: "return { custom: true };" } } });
    const res = await driver.complete({
      messages: scriptMessages("log-triage", false),
      tools: SCRIPT_TOOLS,
    });
    expect(res.text).toBe("return { custom: true };");
  });

  test("cached-heavy usage makes cacheRead dominate fresh input; small stays small", async () => {
    const heavy = await createMockDriver({ seed: 5, usageModel: "cached-heavy" }).complete({
      messages: [
        ...armAMessages("log-triage"),
        { role: "assistant", text: "" },
        { role: "tool", text: "x", toolName: "glob" },
        { role: "assistant", text: "" },
        { role: "tool", text: "y", toolName: "grep" },
      ],
      tools: CONTEXT_TOOLS,
    });
    expect(heavy.usage.cacheRead).toBeGreaterThan(heavy.usage.fresh * 5);

    const small = await createMockDriver({ seed: 5, usageModel: "small" }).complete({
      messages: armAMessages("log-triage"),
      tools: CONTEXT_TOOLS,
    });
    expect(small.usage.cacheRead).toBeLessThan(small.usage.fresh);
    expect(small.usage.cacheWrite).toBe(0);
  });

  test("MOCK_ARM_A_WRITES actually makes every task's verify() pass (drift guard)", async () => {
    for (const task of TASKS) {
      const writes = MOCK_ARM_A_WRITES[task.id];
      expect(writes).toBeDefined();
      const dir = mkdtempSync(join(TMP_ROOT, `d2-mock-${task.id}-`));
      created.push(dir);
      cpSync(join(REPO_ROOT, task.fixture), dir, { recursive: true });
      if (task.setup !== undefined) await task.setup(dir);
      for (const [path, content] of Object.entries(writes as Record<string, string>)) {
        writeFileSync(join(dir, path), content);
      }
      const result = await task.verify(dir);
      if (!result.passed) throw new Error(`${task.id}: ${result.detail ?? "verify failed"}`);
      expect(result.passed).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * arm C decide wiring: §1 question shape + judgeAnswers plumbing
 * ------------------------------------------------------------------ */

/** The escalation threshold the canned `log-triage` program passes to `decide`. */
const ESCALATION_THRESHOLD = 0.5;
/** Tasks whose canned arm-C program is designed to make `d.escalate` true. */
const ESCALATING_TASK_IDS = ["log-triage"] as const;

describe("arm C decide wiring", () => {
  test("the canned decide call uses the §1 ARRAY shape, never the Jev id-keyed wire map", () => {
    for (const task of TASKS) {
      const program = MOCK_PROGRAMS[task.id]?.C;
      expect(program).toBeDefined();
      // §1: `questions` is `DecideQuestion | DecideQuestion[]`; a script passes one of those.
      expect(program).toContain("questions: [");
      expect(program).toContain(`id: "${MOCK_DECIDE_QUESTION_ID}"`);
      expect(program).toContain('mode: "noul"');
      // The wire map (`questions: { <id>: { … } }`) is built inside the tool, never by a script.
      expect(program).not.toMatch(/questions:\s*\{/);
      expect(program).toContain("await tools.typesafe.decide({");
      // The plan's handler, verbatim, still runs on a single verdict.
      expect(program).toContain('if (d.escalate) { console.log("[escalate]", d.reason, item); break }');
      expect(program).toContain("const d = verdicts[0];");
    }
  });

  test("the arm-C program still compiles after the shape change", () => {
    for (const task of TASKS) {
      const program = MOCK_PROGRAMS[task.id]?.C as string;
      expect(() =>
        new Function("tools", "console", `return (async () => {\n${program}\n})();`),
      ).not.toThrow();
    }
  });

  test("exactly the designed task(s) pass a decide escalation threshold", () => {
    const withThreshold = TASKS.filter((task) => (MOCK_PROGRAMS[task.id]?.C ?? "").includes("escalateBelow")).map(
      (task) => task.id,
    );
    expect(withThreshold.sort()).toEqual([...ESCALATING_TASK_IDS].sort());
  });

  test("every task scripts the question id its canned program sends (fake judge throws otherwise)", () => {
    for (const task of TASKS) {
      const answers = (task as TaskWithJudgeAnswers).judgeAnswers;
      expect(answers).toBeDefined();
      const entry = answers?.[MOCK_DECIDE_QUESTION_ID];
      expect(entry).toBeDefined();
      expect(typeof entry?.noul).toBe("number");
    }
  });

  test("the escalating task scripts a low-confidence noul that crosses its threshold", () => {
    for (const task of TASKS) {
      const entry = (task as TaskWithJudgeAnswers).judgeAnswers?.[MOCK_DECIDE_QUESTION_ID];
      // §1 noul confidence is |2p - 1|.
      const confidence = Math.abs(2 * (entry?.noul ?? 0.5) - 1);
      const escalates = confidence < ESCALATION_THRESHOLD;
      expect(`${task.id}:${escalates}`).toBe(
        `${task.id}:${(ESCALATING_TASK_IDS as readonly string[]).includes(task.id)}`,
      );
    }
  });

  test("the fake judge built from a task's judgeAnswers answers the program's request", async () => {
    for (const task of TASKS) {
      const script = (task as TaskWithJudgeAnswers).judgeAnswers ?? {};
      const judge = createFakeJudge(script);
      // Exactly the request the canned program sends: one noul question, id "actionable",
      // criteria `{ true, false }` (the tool turns that into the wire shape).
      const result = await judge.systemOne({
        state: { file: "x" },
        questions: {
          [MOCK_DECIDE_QUESTION_ID]: { type: "noul", criteria: { true: "yes", false: "no" } },
        },
      });
      const answer = result.answers[MOCK_DECIDE_QUESTION_ID];
      expect(answer?.type).toBe("noul");
      expect(answer?.noul).toBe(script[MOCK_DECIDE_QUESTION_ID]?.noul);
    }
  });

  test("a task without judgeAnswers would fail loud (documents why the field is required)", async () => {
    const judge = createFakeJudge({});
    await expect(
      judge.systemOne({ state: "x", questions: { [MOCK_DECIDE_QUESTION_ID]: { type: "noul" } } }),
    ).rejects.toThrow(/no scripted answer/);
  });
});


/* ------------------------------------------------------------------ *
 * opencode CLI driver
 * ------------------------------------------------------------------ */

describe("opencode CLI driver", () => {
  test("fails loudly when the binary is absent", async () => {
    const driver = createOpenCodeCliDriver({ binary: "/nonexistent/definitely-not-opencode" });
    await expect(
      driver.complete({ messages: [{ role: "user", text: "hi" }], tools: [] }),
    ).rejects.toThrow(/not found/);
  });

  test("parses text and token usage from the documented JSON-lines stream", () => {
    const stdout = [
      '{"type":"step_start","timestamp":1,"sessionID":"s","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":2,"sessionID":"s","part":{"type":"text","text":"hello "}}',
      '{"type":"text","timestamp":3,"sessionID":"s","part":{"type":"text","text":"world"}}',
      '{"type":"tool_use","timestamp":4,"sessionID":"s","part":{"type":"tool","tool":"read","input":{"path":"a"}}}',
      '{"type":"step_finish","timestamp":5,"sessionID":"s","part":{"type":"step-finish","reason":"stop","cost":0.0012,"tokens":{"input":100,"output":20,"cache":{"read":900,"write":50}}}}',
    ].join("\n");
    const parsed = parseOpenCodeRunOutput(stdout);
    expect(parsed.sawJson).toBe(true);
    expect(parsed.text).toBe("hello world");
    expect(parsed.usage).toEqual({ fresh: 100, output: 20, cacheRead: 900, cacheWrite: 50, costUsd: 0.0012 });
    expect(parsed.errors).toEqual([]);
  });

  test("accepts the snake_case cache variant and sums multiple steps", () => {
    const stdout = [
      '{"type":"step_finish","timestamp":1,"sessionID":"s","part":{"type":"step-finish","tokens":{"input":10,"output":2,"cache_read":30,"cache_write":4}}}',
      '{"type":"step_finish","timestamp":2,"sessionID":"s","part":{"type":"step-finish","tokens":{"input":5,"output":1,"cache_read":7,"cache_write":0}}}',
    ].join("\n");
    const parsed = parseOpenCodeRunOutput(stdout);
    expect(parsed.usage.fresh).toBe(15);
    expect(parsed.usage.cacheRead).toBe(37);
    expect(parsed.usage.cacheWrite).toBe(4);
    expect(parsed.usage.output).toBe(3);
    expect(parsed.usage.costUsd).toBeUndefined();
  });

  test("collects error events and falls back for non-JSON output", () => {
    const err = parseOpenCodeRunOutput('{"type":"error","timestamp":1,"sessionID":"s","error":{"message":"boom"}}');
    expect(err.errors).toEqual(["boom"]);
    const plain = parseOpenCodeRunOutput("just some text\n");
    expect(plain.sawJson).toBe(false);
    expect(plain.text).toBe("");
  });

  test("driver id names the binary", () => {
    expect(createOpenCodeCliDriver({ binary: "opencode-beta" }).id).toBe("opencode-cli:opencode-beta");
    expect(createOpenCodeCliDriver().id).toBe("opencode-cli:opencode");
  });
});
