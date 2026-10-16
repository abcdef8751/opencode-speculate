import { describe, expect, test } from "bun:test"
import { DECIDE_INPUT_SCHEMA, DECIDE_OUTPUT_SCHEMA } from "./schema"
import type { DecideVerdict } from "./types"

/**
 * (h) A tiny JSON-Schema checker covering exactly the keywords our schemas use — no new
 * dependency. It is not a general-purpose validator; it asserts the contract's shapes.
 */
type Schema = Record<string, unknown>

function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function validate(schema: Schema, value: unknown): boolean {
  if (typeof schema.type === "string" || Array.isArray(schema.type)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.includes(jsonType(value))) return false
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((allowed) => allowed === value)) return false
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((sub) => validate(sub, value))
    if (matches.length !== 1) return false
  }

  if (jsonType(value) === "object") {
    const object = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in object)) return false
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in object && !validate(sub, object[key])) return false
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) return false
      }
    } else if (
      schema.additionalProperties !== null &&
      typeof schema.additionalProperties === "object" &&
      !Array.isArray(schema.additionalProperties)
    ) {
      const additional = schema.additionalProperties as Schema
      for (const key of Object.keys(object)) {
        if (!(key in properties) && !validate(additional, object[key])) return false
      }
    }
    if (typeof schema.minProperties === "number" && Object.keys(object).length < schema.minProperties) {
      return false
    }
  }

  if (jsonType(value) === "array") {
    const array = value as unknown[]
    if (typeof schema.minItems === "number" && array.length < schema.minItems) return false
    if (schema.items !== undefined) {
      for (const item of array) {
        if (!validate(schema.items as Schema, item)) return false
      }
    }
  }

  return true
}

const validQuestion = {
  mode: "noul",
  id: "passed",
  criterion: "did the run pass",
  criteria: { true: "exit 0", false: "any failure" },
}

const validVerdict: DecideVerdict = {
  id: "passed",
  mode: "noul",
  value: true,
  p: 0.96,
  confidence: 0.92,
  modelId: "jev-1.13-free",
  latencyMs: 42,
  cached: false,
  escalate: false,
}

describe("DECIDE_INPUT_SCHEMA", () => {
  test("accepts a single-question call and a batched call", () => {
    expect(
      validate(DECIDE_INPUT_SCHEMA, { state: "some state", questions: validQuestion }),
    ).toBe(true)
    expect(
      validate(DECIDE_INPUT_SCHEMA, {
        state: { nested: [1, 2, 3], ok: null },
        questions: [validQuestion, { mode: "score", id: "sev", levels: ["a", "b"] }],
        escalateBelow: 0.5,
        model: "jev-1.13-free",
        cache: false,
        timeoutMs: 5000,
      }),
    ).toBe(true)
  })

  test("rejects missing required fields and extra top-level properties", () => {
    expect(validate(DECIDE_INPUT_SCHEMA, { questions: validQuestion })).toBe(false)
    expect(validate(DECIDE_INPUT_SCHEMA, { state: "s" })).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, { state: "s", questions: validQuestion, nope: 1 }),
    ).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, { state: "s", questions: validQuestion, cache: "yes" }),
    ).toBe(false)
  })

  test("rejects malformed questions", () => {
    expect(validate(DECIDE_INPUT_SCHEMA, { state: "s", questions: [] })).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, { state: "s", questions: { mode: "other", id: "x" } }),
    ).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, {
        state: "s",
        questions: { mode: "noul", id: "x", extra: true },
      }),
    ).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, { state: "s", questions: { mode: "score", id: "x", levels: ["one"] } }),
    ).toBe(false)
    expect(
      validate(DECIDE_INPUT_SCHEMA, {
        state: "s",
        questions: { mode: "choice", id: "x", options: { a: 1 } },
      }),
    ).toBe(false)
  })
})

describe("DECIDE_OUTPUT_SCHEMA", () => {
  test("accepts a single verdict object and an array of verdicts", () => {
    expect(validate(DECIDE_OUTPUT_SCHEMA, validVerdict)).toBe(true)
    expect(
      validate(DECIDE_OUTPUT_SCHEMA, [
        validVerdict,
        {
          id: "sev",
          mode: "score",
          value: 1.5,
          probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
          confidence: 0.7,
          modelId: "jev-1.13-free",
          latencyMs: 42,
          cached: true,
          escalate: true,
          reason: "confidence 0.700 is below the escalation threshold 0.9",
        },
      ]),
    ).toBe(true)
  })

  test("rejects verdicts missing required fields or with wrong types", () => {
    const { escalate, ...withoutEscalate } = validVerdict
    expect(escalate).toBe(false)
    expect(validate(DECIDE_OUTPUT_SCHEMA, withoutEscalate)).toBe(false)
    expect(validate(DECIDE_OUTPUT_SCHEMA, { ...validVerdict, extra: 1 })).toBe(false)
    expect(validate(DECIDE_OUTPUT_SCHEMA, { ...validVerdict, value: { not: "a scalar" } })).toBe(false)
    expect(validate(DECIDE_OUTPUT_SCHEMA, { ...validVerdict, mode: "other" })).toBe(false)
  })
})
