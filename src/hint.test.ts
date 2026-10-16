import { describe, expect, test } from "bun:test"

import { DEFAULT_MODEL } from "./config.ts"
import { DECIDE_HINT_MAX_LINES, decideHint } from "./hint.ts"

const hint = decideHint()

/* ------------------------------------------------------------------ *
 * Escalation-snippet guards
 *
 * §1's "Consumption caution": the return shape follows the input shape, so an ARRAY
 * `questions` argument yields `DecideVerdict[]`. A snippet that passes an array must therefore
 * reduce the result to one verdict (destructure at the call, or index the bound result) before it
 * reads `.escalate` — otherwise the branch is silently dead code.
 * ------------------------------------------------------------------ */

const DECIDE_CALL = /tools\.typesafe\.decide\(/
const ARRAY_ARGUMENT = /questions:\s*\[/
const DESTRUCTURED_CALL =
  /const\s+\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*await\s+tools\.typesafe\.decide\(/
const PLAIN_CALL = /const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.typesafe\.decide\(/

/** The copy-ready escalation snippet, sliced out of the hint — never hardcoded. */
function escalationSnippet(): string {
  const lines = hint.split("\n")
  const start = lines.findIndex((line) => line.startsWith("const seen = ["))
  expect(start).toBeGreaterThanOrEqual(0)
  return lines.slice(start).join("\n")
}

/**
 * Guard: `true` iff no `decide(` call in `code` passes an ARRAY without extracting a single
 * verdict from it — destructured on the same statement as the call, or indexed
 * (`const d = verdicts[0]`) on the line that binds the call's result. The single-object form is
 * trivially safe (one question ⇒ one verdict) and passes.
 */
function extractsSingleVerdict(code: string): boolean {
  const lines = code.split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (!DECIDE_CALL.test(line) || !ARRAY_ARGUMENT.test(line)) continue
    if (DESTRUCTURED_CALL.test(line)) continue
    const boundName = PLAIN_CALL.exec(line)?.[1]
    const next = lines[i + 1] ?? ""
    const indexed =
      boundName !== undefined &&
      new RegExp(`const\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${boundName}\\[\\s*0\\s*\\]`).test(next)
    if (!indexed) return false
  }
  return true
}

interface SnippetRun {
  /** Everything the snippet passed to `console.log` (surfaced to the model as `Logs:`). */
  logs: string[]
  decideCalls: number
  stepRuns: string[]
}

/** Execute the snippet for real against a fake `tools.typesafe.decide`, fake steps and fake console. */
async function runEscalationSnippet(code: string): Promise<SnippetRun> {
  const logs: string[] = []
  const stepRuns: string[] = []
  let decideCalls = 0
  const steps = [
    {
      tool: "read",
      run: async () => {
        stepRuns.push("read")
        return "file contents"
      },
    },
    {
      tool: "shell",
      run: async () => {
        stepRuns.push("shell")
        return "should never run"
      },
    },
  ]
  const tools = {
    typesafe: {
      decide: async () => {
        decideCalls += 1
        // an array argument ⇒ an array result (§1)
        return [
          {
            id: "goal-met?",
            mode: "noul",
            value: false,
            confidence: 0.31,
            escalate: true,
            reason: "confidence 0.31 < 0.6",
          },
        ]
      },
    },
  }
  const fakeConsole = {
    log: (value: unknown) => {
      logs.push(String(value))
    },
  }
  const run = new Function(
    "steps",
    "tools",
    "console",
    `return (async () => {\n${code}\n})()`,
  ) as (steps: unknown, tools: unknown, console: unknown) => Promise<void>
  await run(steps, tools, fakeConsole)
  return { logs, decideCalls, stepRuns }
}

describe("decideHint", () => {
  test("names the Code Mode tool path and the search fallback", () => {
    expect(hint).toContain("tools.typesafe.decide")
    expect(hint).toContain('search("decide")')
    // never the un-namespaced form
    expect(/\btools\.decide\b/.test(hint)).toBe(false)
  })

  test("covers the call shapes and every question key from §1", () => {
    expect(hint).toContain("value")
    expect(hint).toMatch(/\bmode\b/)
    expect(hint).toMatch(/\bid\b/)
    expect(hint).toMatch(/\bcriterion\b/)
    expect(hint).toMatch(/\bcriteria\b/)
    expect(hint).toMatch(/\boptions\b/)
    expect(hint).toMatch(/\blevels\b/)
    expect(hint).toMatch(/\bescalateBelow\b/)
    expect(hint).toMatch(/\bstate\b/)
    expect(hint).toMatch(/\bquestions\b/)
    for (const mode of ["noul", "choice", "score"]) {
      expect(hint).toContain(mode)
    }
    // one question → one verdict, an array → an array
    expect(hint).toMatch(/array of questions/i)
    expect(hint).toMatch(/array of verdicts/i)
  })

  test("teaches `questions` as a bare question object or an array — never an id-keyed map", () => {
    const lines = hint.split("\n")
    const oneLine = lines.find((line) => line.startsWith("one:"))
    const manyLine = lines.find((line) => line.startsWith("many:"))
    expect(oneLine).toBeDefined()
    expect(manyLine).toBeDefined()

    // the one-question form is a bare question object (not `{ <id>: { … } }`)
    expect(oneLine).toMatch(/questions:\s*\{\s*mode:\s*"/)
    expect(oneLine).not.toMatch(/questions:\s*\{\s*["']?\w+["']?\s*:\s*\{/)
    // the multi-question form is an array of question objects
    expect(manyLine).toMatch(/questions:\s*\[\s*\{\s*mode:\s*"/)
    expect(manyLine).toMatch(/\]\s*$/)

    // nowhere does the hint show the id-keyed map that the engine rejects at validation
    expect(hint).not.toMatch(
      /\{\s*["']?[A-Za-z_][\w-]*["']?\s*:\s*\{\s*mode:\s*["']?(noul|choice|score)["']?/,
    )
    expect(hint).toMatch(/never an id-keyed map/i)

    // the copy-ready escalation snippet passes an array too
    expect(hint).toMatch(/questions:\s*\[\s*\{\s*mode:\s*"noul"/)
  })

  test("makes the recorded step shape explicit so a copied handler cannot fail", () => {
    // `seen` holds the { tool, out } entries the script pushed…
    expect(hint).toMatch(/\{\s*tool,\s*out\s*\}\s*entr/)
    expect(hint).toMatch(/push\(\{\s*tool:\s*step\.tool,\s*out\s*\}\)/)
    // …and a step always carries `tool`, so `seen.map(s => s.tool)` is safe
    expect(hint).toMatch(/step = \{\s*tool,\s*run\(\)\s*\}/)
    expect(hint).toContain("last: seen.at(-1)")
    expect(hint).toContain("done: seen.map(s => s.tool)")
  })

  test("the escalation snippet extracts one verdict from the array result", () => {
    const code = escalationSnippet()
    const callLine = code.split("\n").find((line) => line.includes("tools.typesafe.decide(")) ?? ""

    // array in ⇒ array out, so the call statement must reduce it to a single verdict
    expect(callLine).toMatch(ARRAY_ARGUMENT)
    const destructured = DESTRUCTURED_CALL.exec(callLine)
    expect(destructured).not.toBeNull()
    const name = destructured?.[1] ?? ""
    expect(name).not.toBe("")
    // …and the branch must read `.escalate`/`.reason` off that very binding
    expect(code).toMatch(new RegExp(`if\\s*\\(\\s*${name}\\.escalate\\s*\\)`))
    expect(code).toContain(`${name}.reason`)
    expect(extractsSingleVerdict(code)).toBe(true)
  })

  test("states the array-result consumption rule in prose too", () => {
    expect(hint).toMatch(/destructure or index/i)
    expect(hint).toContain("before reading `.escalate`")
  })

  test("running the snippet actually fires the handler and breaks", async () => {
    const { logs, decideCalls, stepRuns } = await runEscalationSnippet(escalationSnippet())
    expect(decideCalls).toBe(1) // `break` fired after the low-confidence verdict
    expect(stepRuns).toEqual(["read"]) // the second step never ran
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0] ?? "null")).toEqual({
      reason: "confidence 0.31 < 0.6",
      last: { tool: "read", out: "file contents" },
      done: ["read"],
    })
  })

  test("the old shape (array in, no extraction) is dead code the guard rejects", async () => {
    const broken = escalationSnippet().replace("const [d] = await", "const d = await")
    // the mutation really applied, and the static guard rejects the result
    expect(broken).not.toBe(escalationSnippet())
    expect(broken).toContain("const d = await tools.typesafe.decide(")
    expect(extractsSingleVerdict(broken)).toBe(false)

    // and it is dead for real: `d` is an array, `d.escalate` is undefined, nothing logs or breaks
    const { logs, decideCalls, stepRuns } = await runEscalationSnippet(broken)
    expect(decideCalls).toBe(2)
    expect(stepRuns).toEqual(["read", "shell"])
    expect(logs).toEqual([])
  })

  test("the guard also accepts the index form and the single-object form", () => {
    const indexed = [
      'const verdicts = await tools.typesafe.decide({ state, questions: [{ mode: "noul", id: "a" }] })',
      "const d = verdicts[0]",
      "if (d.escalate) { break }",
    ].join("\n")
    expect(extractsSingleVerdict(indexed)).toBe(true)

    // one question OBJECT ⇒ one verdict: no extraction needed
    const single =
      'const d = await tools.typesafe.decide({ state, questions: { mode: "noul", id: "a", criteria: { true: "y", false: "n" } } })'
    expect(extractsSingleVerdict(single)).toBe(true)
  })

  test("covers every verdict field from §1", () => {
    expect(hint).toMatch(/\bvalue\b/)
    expect(hint).toMatch(/\bp\b/)
    expect(hint).toMatch(/\bprobabilities\b/)
    expect(hint).toMatch(/\bconfidence\b/)
    expect(hint).toMatch(/\bmodelId\b/)
    expect(hint).toMatch(/\blatencyMs\b/)
    expect(hint).toMatch(/\bcached\b/)
    expect(hint).toMatch(/\bescalate\b/)
    expect(hint).toMatch(/\breason\b/)
  })

  test("carries the escalation handler with the break / Logs: / ledger semantics", () => {
    expect(hint).toMatch(/\bbreak\b/)
    expect(hint).toContain("console.log")
    expect(hint).toContain("Logs:")
    expect(hint).toContain("reason: d.reason")
    expect(hint).toContain("seen.at(-1)")
    expect(hint).toContain("done: seen.map(s => s.tool)")
    expect(hint).toMatch(/JSON\.stringify/)
  })

  test("stays under the line cap", () => {
    const lines = hint.split("\n")
    expect(lines.length).toBeLessThanOrEqual(DECIDE_HINT_MAX_LINES)
    expect(lines.length).toBeLessThanOrEqual(25)
    expect(lines.every((line) => line === line.trimEnd())).toBe(true)
  })

  test("is deterministic and config-dependent only through the pinned model", () => {
    expect(decideHint()).toBe(decideHint())
    expect(decideHint({ model: DEFAULT_MODEL })).toBe(hint)
    expect(decideHint({ model: " custom-model " })).toBe(decideHint({ model: " custom-model " }))
    const custom = decideHint({ model: "custom-model" })
    expect(custom).toContain("custom-model")
    expect(custom).not.toBe(hint)
    // a blank model falls back to the default rather than printing an empty id
    expect(decideHint({ model: "  " })).toBe(hint)
  })

  test("mentions the threshold semantics", () => {
    expect(hint).toMatch(/confidence\s*<\s*escalateBelow/)
  })
})
