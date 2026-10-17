import { describe, expect, test } from "bun:test"

import { DEFAULT_MODEL } from "./config.ts"
import { DECIDE_HINT_MAX_LINES, decideHint } from "./hint.ts"

const hint = decideHint()

/* ------------------------------------------------------------------ *
 * Escalation-snippet guards
 *
 * §1's "Consumption caution": the return shape follows the input shape, so an ARRAY
 * `questions` argument yields `DecideVerdict[]`. A snippet that passes an array must therefore
 * reduce the result to one verdict (destructure at the call) before it reads `.escalate` —
 * otherwise the branch is silently dead code.
 *
 * The snippet is also run for real below: every identifier in it must exist (`tools`, `console`,
 * its own `out`/`d`). An earlier version looped over a host-provided `steps` array that the
 * runtime does not define, so copying it threw `steps is not defined`.
 * ------------------------------------------------------------------ */

const DECIDE_CALL = /tools\.typesafe\.decide\(/
const ARRAY_ARGUMENT = /questions:\s*\[/
const DESTRUCTURED_CALL =
  /const\s+\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*await\s+tools\.typesafe\.decide\(/
const PLAIN_CALL = /const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.typesafe\.decide\(/

/** The copy-ready escalation snippet, sliced out of the hint — never hardcoded. */
function escalationSnippet(): string {
  const lines = hint.split("\n")
  const start = lines.findIndex((line) => line.startsWith("const out = await tools.shell"))
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
  /** What the snippet returned from the (async) script body. */
  returned: unknown
  /** Everything the snippet passed to `console.log` (surfaced to the model as `Logs:`). */
  logs: string[]
  decideCalls: number
  shellCalls: number
}

/** Execute the snippet for real against fake `tools` and a fake console. */
async function runEscalationSnippet(code: string, verdict: unknown): Promise<SnippetRun> {
  const logs: string[] = []
  let decideCalls = 0
  let shellCalls = 0
  const tools = {
    shell: async () => {
      shellCalls += 1
      return { output: "FAIL src/auth.test.ts\n1 failing" }
    },
    typesafe: {
      decide: async () => {
        decideCalls += 1
        return verdict
      },
    },
  }
  const fakeConsole = { log: (value: unknown) => logs.push(String(value)) }
  const run = new Function(
    "tools",
    "console",
    `return (async () => {\n${code}\n})()`,
  ) as (tools: unknown, console: unknown) => Promise<unknown>
  const returned = await run(tools, fakeConsole)
  return { returned, logs, decideCalls, shellCalls }
}

const UNSURE = [
  {
    id: "green?",
    mode: "noul",
    value: false,
    confidence: 0.31,
    escalate: true,
    reason: "confidence 0.31 < 0.6",
  },
]

const SURE = [
  {
    id: "green?",
    mode: "noul",
    value: true,
    confidence: 0.91,
    escalate: false,
  },
]

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

  test("the snippet is self-contained — nothing it names comes from the host", () => {
    const code = escalationSnippet()
    // the fictional `steps` / `step.run()` loop is gone: no identifier the runtime never defines
    expect(code).not.toMatch(/\bsteps\b/)
    expect(code).not.toMatch(/\bstep\.run\b/)
    expect(code).not.toMatch(/\bseen\b/)
    // it binds everything from real tool calls and ends in a return
    expect(code).toMatch(/^const out = await tools\.shell\(/)
    expect(code).toContain("const [d] = await tools.typesafe.decide(")
    expect(code.trimEnd().endsWith("return { green: d.value }")).toBe(true)
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

  test("running the snippet stops and reports when the verdict escalates", async () => {
    const { returned, logs, decideCalls, shellCalls } = await runEscalationSnippet(
      escalationSnippet(),
      UNSURE,
    )
    expect(decideCalls).toBe(1)
    expect(shellCalls).toBe(1)
    expect(returned).toEqual({ stop: true, reason: "confidence 0.31 < 0.6" })
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0] ?? "null")).toEqual({
      reason: "confidence 0.31 < 0.6",
      excerpt: "FAIL src/auth.test.ts\n1 failing",
    })
  })

  test("running the snippet returns the value when the verdict is confident", async () => {
    const { returned, logs, decideCalls } = await runEscalationSnippet(escalationSnippet(), SURE)
    expect(decideCalls).toBe(1)
    expect(returned).toEqual({ green: true })
    expect(logs).toEqual([])
  })

  test("the old shape (array in, no extraction) is dead code the guard rejects", async () => {
    const broken = escalationSnippet().replace("const [d] = await", "const d = await")
    // the mutation really applied, and the static guard rejects the result
    expect(broken).not.toBe(escalationSnippet())
    expect(broken).toContain("const d = await tools.typesafe.decide(")
    expect(extractsSingleVerdict(broken)).toBe(false)

    // and it is dead for real: `d` is an array, `d.escalate` is undefined, so it never stops
    const { returned, logs, decideCalls } = await runEscalationSnippet(broken, UNSURE)
    expect(decideCalls).toBe(1)
    expect(logs).toEqual([])
    expect(returned).toEqual({ green: undefined })
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

  test("carries the escalation handler with the Logs: / return semantics", () => {
    expect(hint).toContain("console.log")
    expect(hint).toContain("Logs:")
    expect(hint).toContain("reason: d.reason")
    expect(hint).toMatch(/JSON\.stringify/)
    // the handler returns rather than break-ing: there is no host-provided loop to break out of
    expect(hint).toContain("return { stop: true, reason: d.reason }")
    expect(hint).toMatch(/stop and report/i)
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
