import { describe, expect, test } from "bun:test"
import { createDecideRuntime, createDecideTool, formatVerdictLine, parseDecideInput } from "./tool"
import { DECIDE_INPUT_SCHEMA, DECIDE_OUTPUT_SCHEMA } from "./schema"
import { DECIDE_NAMESPACE, DECIDE_TOOL_NAME } from "./types"
import type {
  EngineDeps,
} from "./engine"
import type { DecideQuestion, DecideVerdict, Json, Judge, SystemOneAnswer, SystemOneResult } from "./types"

function judgeWith(map: Record<string, SystemOneAnswer>): Judge {
  return {
    modelId: "jev-tool-test",
    async systemOne(): Promise<SystemOneResult> {
      return { model: "jev-tool-test", answers: map, usage: { input_tokens: 3, output_tokens: 4 } }
    },
  }
}

function memoryStorage(): EngineDeps["storage"] {
  const map = new Map<string, Json>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
  }
}

function runtimeDeps(answers: Record<string, SystemOneAnswer>): EngineDeps {
  return { judge: judgeWith(answers), storage: memoryStorage(), now: () => 0 }
}

const qa: DecideQuestion = {
  mode: "noul",
  id: "ok",
  criteria: { true: "yes", false: "no" },
}
const qb: DecideQuestion = {
  mode: "choice",
  id: "who",
  options: { alice: "alice did it", bob: "bob did it" },
}

describe("createDecideRuntime", () => {
  test("exposes a tool with the frozen name/namespace/options", () => {
    const { tool } = createDecideRuntime(runtimeDeps({}))
    expect(tool.name).toBe(DECIDE_TOOL_NAME)
    expect(tool.options).toEqual({ namespace: DECIDE_NAMESPACE, codemode: true, pinned: true })
    expect(tool.input).toBe(DECIDE_INPUT_SCHEMA)
    expect(tool.output).toBe(DECIDE_OUTPUT_SCHEMA)
    expect(tool.description.length).toBeGreaterThan(20)
  })

  test("call() runs the engine and returns a single verdict object for a single question", async () => {
    const { call } = createDecideRuntime(runtimeDeps({ ok: { type: "noul", noul: 0.9 } }))
    const out = await call({ state: "s", questions: qa, cache: false })
    expect(Array.isArray(out)).toBe(false)
    expect((out as DecideVerdict).id).toBe("ok")
    expect((out as DecideVerdict).value).toBe(true)
  })

  test("execute returns { output, content } with one compact line per verdict", async () => {
    const { tool } = createDecideRuntime(
      runtimeDeps({
        ok: { type: "noul", noul: 0.9 },
        who: { type: "choice", choice: "bob", confidence: 1, probabilities: { alice: 0, bob: 1 } },
      }),
    )
    const result = await tool.execute({ state: "s", questions: [qa, qb], cache: false })
    expect(Array.isArray(result.output)).toBe(true)
    const output = result.output as DecideVerdict[]
    expect(output.map((v) => v.id)).toEqual(["ok", "who"])
    expect(result.content).toBe(
      ["ok: value=true confidence=0.800 escalate=false", 'who: value="bob" confidence=1.000 escalate=false'].join(
        "\n",
      ),
    )
  })

  test("execute handles a single question and quotes string values", async () => {
    const { tool } = createDecideRuntime(
      runtimeDeps({ who: { type: "choice", choice: "alice", confidence: 1, probabilities: { alice: 1, bob: 0 } } }),
    )
    const result = await tool.execute({ state: "s", questions: qb, cache: false })
    expect(Array.isArray(result.output)).toBe(false)
    expect(result.content).toBe('who: value="alice" confidence=1.000 escalate=false')
  })

  test("createDecideTool returns the same tool definition", () => {
    const tool = createDecideTool(runtimeDeps({}))
    expect(tool.name).toBe("decide")
    expect(tool.options.namespace).toBe("typesafe")
  })
})

describe("parseDecideInput", () => {
  test("normalizes a full call", () => {
    expect(
      parseDecideInput({
        state: { a: 1 },
        questions: qa,
        escalateBelow: 0.5,
        model: "m",
        cache: false,
        timeoutMs: 100,
      }),
    ).toEqual({
      state: { a: 1 },
      questions: qa,
      escalateBelow: 0.5,
      model: "m",
      cache: false,
      timeoutMs: 100,
    })
  })

  test("rejects malformed payloads", () => {
    expect(() => parseDecideInput(null)).toThrow(/must be an object/)
    expect(() => parseDecideInput([])).toThrow(/must be an object/)
    expect(() => parseDecideInput({ questions: qa })).toThrow(/"state" is required/)
    expect(() => parseDecideInput({ state: "s" })).toThrow(/"questions" is required/)
    expect(() => parseDecideInput({ state: "s", questions: qa, cache: "yes" })).toThrow(/"cache" must be a boolean/)
    expect(() => parseDecideInput({ state: "s", questions: qa, escalateBelow: "x" })).toThrow(
      /"escalateBelow" must be a number/,
    )
    expect(() => parseDecideInput({ state: "s", questions: qa, model: 5 })).toThrow(/"model" must be a string/)
    expect(() => parseDecideInput({ state: "s", questions: qa, timeoutMs: "x" })).toThrow(
      /"timeoutMs" must be a number/,
    )
  })

  test("a malformed execute input rejects and produces no output", async () => {
    const { tool } = createDecideRuntime(runtimeDeps({}))
    await expect(tool.execute({ state: "s" })).rejects.toThrow(/"questions" is required/)
  })
})

describe("formatVerdictLine", () => {
  test("renders the four contract fields", () => {
    const verdict: DecideVerdict = {
      id: "x",
      mode: "score",
      value: 1.25,
      confidence: 0.33333,
      modelId: "m",
      latencyMs: 1,
      cached: false,
      escalate: true,
      reason: "low",
    }
    expect(formatVerdictLine(verdict)).toBe("x: value=1.25 confidence=0.333 escalate=true")
  })
})
