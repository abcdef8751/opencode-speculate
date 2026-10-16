import { describe, expect, test } from "bun:test"

import { DEFAULT_MODEL } from "./config.ts"
import { DECIDE_HINT_MAX_LINES, decideHint } from "./hint.ts"

const hint = decideHint()

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
