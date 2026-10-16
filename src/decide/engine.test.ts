import { describe, expect, test } from "bun:test"
import {
  decideCacheKey,
  effectiveThreshold,
  escalationFor,
  normalizeChoiceConfidence,
  normalizeNoulConfidence,
  normalizeScoreConfidence,
  parseCachedVerdict,
  runDecide,
  stableStringify,
  toCachedVerdict,
  type EngineDeps,
} from "./engine"
import type {
  DecideCall,
  DecideQuestion,
  DecideVerdict,
  Json,
  Judge,
  StoragePort,
  SystemOneAnswer,
  SystemOneRequest,
  SystemOneResult,
} from "./types"

/* ------------------------------------------------------------------ *
 * Test doubles — no network, deterministic clock/hash.
 * ------------------------------------------------------------------ */

interface FakeJudge extends Judge {
  calls: SystemOneRequest[]
}

function createJudge(
  handler: (req: SystemOneRequest) => SystemOneResult | Promise<SystemOneResult>,
  modelId = "jev-test",
): FakeJudge {
  const calls: SystemOneRequest[] = []
  return {
    modelId,
    calls,
    async systemOne(req) {
      calls.push(req)
      return handler(req)
    },
  }
}

function answers(map: Record<string, SystemOneAnswer>): SystemOneResult {
  return {
    model: "jev-response",
    answers: map,
    usage: { input_tokens: 11, output_tokens: 7 },
  }
}

function createStorage(): StoragePort & { map: Map<string, Json> } {
  const map = new Map<string, Json>()
  return {
    map,
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
  }
}

function createLog(): { entries: Json[]; log: (entry: Json) => void } {
  const entries: Json[] = []
  return { entries, log: (entry) => void entries.push(entry) }
}

const qa: DecideQuestion = {
  mode: "noul",
  id: "a",
  criterion: "did it pass",
  criteria: { true: "all good", false: "any failure" },
}
const qb: DecideQuestion = { mode: "score", id: "b", criterion: "how bad", levels: ["none", "mild", "fatal"] }
const qc: DecideQuestion = {
  mode: "choice",
  id: "c",
  criterion: "which module",
  options: { auth: "the auth module", db: "the database layer" },
}

function deps(
  judge: Judge,
  log?: (entry: Json) => void,
): EngineDeps & { storage: ReturnType<typeof createStorage> } {
  return {
    judge,
    storage: createStorage(),
    now: () => 1000,
    hash: (input) => `h(${input})`,
    ...(log ? { log } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * (a) batch → one request, one verdict per question, order preserved
 * ------------------------------------------------------------------ */

describe("batching", () => {
  test("an array of questions is ONE request with one verdict per question, order preserved", async () => {
    const judge = createJudge(() =>
      answers({
        a: { type: "noul", noul: 0.9 },
        b: { type: "score", score: 1.5, confidence: 0.4 },
        c: { type: "choice", choice: "db", confidence: 1, probabilities: { auth: 0, db: 1 } },
      }),
    )
    const out = await runDecide(deps(judge), { state: "state text", questions: [qa, qb, qc], cache: false })

    expect(judge.calls).toHaveLength(1)
    const request = judge.calls[0]!
    expect(Object.keys(request.questions)).toEqual(["a", "b", "c"])
    expect(request.questions.a).toEqual({
      type: "noul",
      instructions: "did it pass",
      criteria: { true: "all good", false: "any failure" },
    })
    expect(request.questions.b).toEqual({
      type: "score",
      instructions: "how bad",
      criteria: ["none", "mild", "fatal"],
    })
    expect(request.questions.c).toEqual({
      type: "choice",
      instructions: "which module",
      criteria: { auth: "the auth module", db: "the database layer" },
    })

    expect(Array.isArray(out)).toBe(true)
    const verdicts = out as DecideVerdict[]
    expect(verdicts.map((v) => v.id)).toEqual(["a", "b", "c"])
    expect(verdicts[0]!.value).toBe(true)
    expect(verdicts[1]!.value).toBe(1.5)
    expect(verdicts[2]!.value).toBe("db")
  })

  test("duplicate ids in one call throw", async () => {
    const judge = createJudge(() => answers({}))
    await expect(
      runDecide(deps(judge), { state: "s", questions: [qa, { ...qa }], cache: false }),
    ).rejects.toThrow(/duplicate question id "a"/)
    expect(judge.calls).toHaveLength(0)
  })

  test("an empty array and malformed questions throw", async () => {
    const judge = createJudge(() => answers({}))
    await expect(runDecide(deps(judge), { state: "s", questions: [], cache: false })).rejects.toThrow(
      /must not be empty/,
    )
    await expect(
      runDecide(deps(judge), {
        state: "s",
        questions: [{ mode: "noul", id: "x" } as unknown as DecideQuestion],
        cache: false,
      }),
    ).rejects.toThrow(/criteria\.true/)
    await expect(
      runDecide(deps(judge), {
        state: "s",
        questions: [{ mode: "choice", id: "x", options: {} } as unknown as DecideQuestion],
        cache: false,
      }),
    ).rejects.toThrow(/options map/)
    await expect(
      runDecide(deps(judge), {
        state: "s",
        questions: [{ mode: "score", id: "x", levels: ["only"] } as unknown as DecideQuestion],
        cache: false,
      }),
    ).rejects.toThrow(/two levels/)
  })
})

/* ------------------------------------------------------------------ *
 * (b) single question → single object (not an array)
 * ------------------------------------------------------------------ */

describe("single question", () => {
  test("returns a single verdict object", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.96 } }))
    const out = await runDecide(deps(judge), { state: "s", questions: qa, cache: false })
    expect(Array.isArray(out)).toBe(false)
    const verdict = out as DecideVerdict
    expect(verdict.id).toBe("a")
    expect(verdict.mode).toBe("noul")
    expect(verdict.value).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * (c) confidence math for all three modes
 * ------------------------------------------------------------------ */

describe("confidence normalization", () => {
  test("noul: |2p − 1|", () => {
    expect(normalizeNoulConfidence(0.96)).toBeCloseTo(0.92, 10)
    expect(normalizeNoulConfidence(0.5)).toBe(0)
    expect(normalizeNoulConfidence(0)).toBe(1)
    expect(normalizeNoulConfidence(1)).toBe(1)
    expect(normalizeNoulConfidence(Number.NaN)).toBe(0)
  })

  test("choice: (p_max − 1/n) / (1 − 1/n), with n = 1 ⇒ 1", () => {
    expect(normalizeChoiceConfidence({ a: 1, b: 0 }, 2)).toBeCloseTo(1, 10)
    expect(normalizeChoiceConfidence({ a: 0.5, b: 0.5 }, 2)).toBeCloseTo(0, 10)
    expect(normalizeChoiceConfidence({ a: 0.4, b: 0.3, c: 0.2, d: 0.1 }, 4)).toBeCloseTo(0.2, 10)
    expect(normalizeChoiceConfidence({ only: 1 }, 1)).toBe(1)
    expect(normalizeChoiceConfidence({}, 3)).toBe(0)
    expect(normalizeChoiceConfidence({ a: Number.NaN, b: 1 }, 2)).toBeCloseTo(1, 10)
  })

  test("score: the API confidence as-is; null/absent ⇒ 0", () => {
    expect(normalizeScoreConfidence(0.7)).toBe(0.7)
    expect(normalizeScoreConfidence(null)).toBe(0)
    expect(normalizeScoreConfidence(undefined)).toBe(0)
    expect(normalizeScoreConfidence(Number.NaN)).toBe(0)
  })

  test("confidence flows into the verdict for each mode", async () => {
    const judge = createJudge(() =>
      answers({
        a: { type: "noul", noul: 0.6 }, // |2*.6-1| = 0.2
        b: { type: "score", score: 2 }, // no confidence ⇒ 0
        c: { type: "choice", choice: "auth", confidence: 1, probabilities: { auth: 1, db: 0 } },
      }),
    )
    const out = (await runDecide(deps(judge), {
      state: "s",
      questions: [qa, qb, { ...qc, options: { auth: "auth module" } }],
      cache: false,
    })) as DecideVerdict[]
    expect(out[0]!.confidence).toBeCloseTo(0.2, 10)
    expect(out[1]!.confidence).toBe(0)
    expect(out[2]!.confidence).toBe(1)
    // noul exposes p; choice/score expose probabilities.
    expect(out[0]!.p).toBeCloseTo(0.6, 10)
    expect(out[2]!.probabilities).toEqual({ auth: 1, db: 0 })
  })
})

/* ------------------------------------------------------------------ *
 * (d) escalation
 * ------------------------------------------------------------------ */

describe("escalation", () => {
  const lowConfidenceJudge = () =>
    createJudge(() =>
      answers({
        a: { type: "noul", noul: 0.6 }, // confidence 0.2
        b: { type: "score", score: 1, confidence: 0.9 },
      }),
    )

  test("no threshold anywhere ⇒ never escalates (opt-in)", async () => {
    const out = (await runDecide(deps(lowConfidenceJudge()), {
      state: "s",
      questions: [qa, qb],
      cache: false,
    })) as DecideVerdict[]
    expect(out.every((v) => v.escalate === false)).toBe(true)
    expect(out.every((v) => v.reason === undefined)).toBe(true)
  })

  test("call-level threshold escalates only below the threshold, with a reason", async () => {
    const out = (await runDecide(deps(lowConfidenceJudge()), {
      state: "s",
      questions: [qa, qb],
      escalateBelow: 0.5,
      cache: false,
    })) as DecideVerdict[]
    expect(out[0]!.escalate).toBe(true)
    expect(out[0]!.reason).toContain("confidence 0.200")
    expect(out[0]!.reason).toContain("threshold 0.5")
    expect(out[1]!.escalate).toBe(false)
    expect(out[1]!.reason).toBeUndefined()
  })

  test("per-question override wins over the call-level default", async () => {
    const judge = lowConfidenceJudge()
    const out = (await runDecide(deps(judge), {
      state: "s",
      questions: [{ ...qa, escalateBelow: 0.1 }, { ...qb, escalateBelow: 0.95 }],
      escalateBelow: 0.5,
      cache: false,
    })) as DecideVerdict[]
    // a: 0.2 > 0.1 ⇒ no escalate despite the call default of 0.5.
    expect(out[0]!.escalate).toBe(false)
    // b: 0.9 < 0.95 ⇒ escalate despite the call default of 0.5.
    expect(out[1]!.escalate).toBe(true)
    expect(out[1]!.reason).toContain("threshold 0.95")
  })

  test("a missing/unusable answer escalates even with no threshold, naming the cause", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } })) // b missing
    const out = (await runDecide(deps(judge), {
      state: "s",
      questions: [qa, qb],
      cache: false,
    })) as DecideVerdict[]
    expect(out[0]!.escalate).toBe(false)
    expect(out[1]!.escalate).toBe(true)
    expect(out[1]!.confidence).toBe(0)
    expect(out[1]!.reason).toContain('no usable score answer returned for question "b"')
  })

  test("a choice label outside the declared options escalates with a reason", async () => {
    const judge = createJudge(() =>
      answers({ c: { type: "choice", choice: "nope", confidence: 1, probabilities: { nope: 1 } } }),
    )
    const out = (await runDecide(deps(judge), { state: "s", questions: qc, cache: false })) as DecideVerdict
    expect(out.value).toBe("nope")
    expect(out.escalate).toBe(true)
    expect(out.reason).toContain('not one of the declared options')
  })

  test("effectiveThreshold / escalationFor are pure and explicit", () => {
    expect(effectiveThreshold(qa, {})).toBeUndefined()
    expect(effectiveThreshold(qa, { escalateBelow: 0.5 })).toBe(0.5)
    expect(effectiveThreshold({ ...qa, escalateBelow: 0.2 }, { escalateBelow: 0.5 })).toBe(0.2)
    // Literal `??` semantics: a non-finite per-question value wins the coalesce, then fails the
    // finiteness check — the call default is NOT consulted (a non-finite threshold is ignored).
    expect(effectiveThreshold({ ...qa, escalateBelow: Number.NaN }, { escalateBelow: 0.5 })).toBeUndefined()
    expect(effectiveThreshold({ ...qa, escalateBelow: 0 }, { escalateBelow: 0.5 })).toBe(0)
    expect(escalationFor({ confidence: 0.9, threshold: 0.5 })).toEqual({ escalate: false })
    expect(escalationFor({ confidence: 0.9 })).toEqual({ escalate: false })
    expect(escalationFor({ confidence: 0.1 })).toEqual({ escalate: false })
    expect(escalationFor({ confidence: 0.1, unusable: "no answer" })).toEqual({
      escalate: true,
      reason: "no answer",
    })
  })
})

/* ------------------------------------------------------------------ *
 * (e) cache
 * ------------------------------------------------------------------ */

describe("cache", () => {
  test("a second identical call is a cache hit with no second judge request", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } }))
    const d = deps(judge)
    const call: DecideCall = { state: "s", questions: qa }

    const first = (await runDecide(d, call)) as DecideVerdict
    expect(first.cached).toBe(false)
    expect(judge.calls).toHaveLength(1)

    const second = (await runDecide(d, call)) as DecideVerdict
    expect(second.cached).toBe(true)
    expect(second.latencyMs).toBe(0)
    expect(second.value).toBe(first.value)
    expect(judge.calls).toHaveLength(1)
  })

  test("cache: false bypasses the cache both ways", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } }))
    const d = deps(judge)
    await runDecide(d, { state: "s", questions: qa, cache: false })
    const second = (await runDecide(d, { state: "s", questions: qa, cache: false })) as DecideVerdict
    expect(second.cached).toBe(false)
    expect(judge.calls).toHaveLength(2)
    expect(d.storage.map.size).toBe(0)

    // A cache:false result must not have been stored; a default call now misses.
    const third = (await runDecide(d, { state: "s", questions: qa })) as DecideVerdict
    expect(third.cached).toBe(false)
    expect(judge.calls).toHaveLength(3)
  })

  test("a question may hit while siblings miss — one request for the misses only", async () => {
    const judge = createJudge((req) => {
      const map: Record<string, SystemOneAnswer> = {}
      for (const id of Object.keys(req.questions)) {
        map[id] = { type: "noul", noul: 0.9 }
      }
      return answers(map)
    })
    const d = deps(judge)

    await runDecide(d, { state: "s", questions: qa })
    expect(judge.calls).toHaveLength(1)

    const out = (await runDecide(d, { state: "s", questions: [qa, qb] })) as DecideVerdict[]
    expect(judge.calls).toHaveLength(2)
    expect(Object.keys(judge.calls[1]!.questions)).toEqual(["b"])
    expect(out.find((v) => v.id === "a")!.cached).toBe(true)
    expect(out.find((v) => v.id === "b")!.cached).toBe(false)
  })

  test("a batch is skipped only if every question hits", async () => {
    const judge = createJudge((req) => {
      const map: Record<string, SystemOneAnswer> = {}
      for (const id of Object.keys(req.questions)) map[id] = { type: "noul", noul: 0.9 }
      return answers(map)
    })
    const d = deps(judge)
    await runDecide(d, { state: "s", questions: [qa, qb] })
    expect(judge.calls).toHaveLength(1)

    const out = (await runDecide(d, { state: "s", questions: [qa, qb] })) as DecideVerdict[]
    expect(judge.calls).toHaveLength(1)
    expect(out.every((v) => v.cached === true)).toBe(true)
  })

  test("different state ⇒ different key", () => {
    const hash = (s: string) => s
    expect(decideCacheKey(hash, "one", qa)).toBe(decideCacheKey(hash, "one", qa))
    expect(decideCacheKey(hash, "one", qa)).not.toBe(decideCacheKey(hash, "two", qa))
    // Object key order must not matter.
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  test("cache entries round-trip without latencyMs/cached", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } }))
    const d = deps(judge)
    const verdict = (await runDecide(d, { state: "s", questions: qa })) as DecideVerdict
    const key = [...d.storage.map.keys()][0]!
    const stored = d.storage.map.get(key) as Record<string, unknown>
    expect("latencyMs" in stored).toBe(false)
    expect("cached" in stored).toBe(false)
    expect(parseCachedVerdict(stored as unknown as Json)?.id).toBe("a")
    expect(toCachedVerdict(verdict).id).toBe("a")
    // Corrupt entries are treated as misses.
    expect(parseCachedVerdict({ nope: true } as unknown as Json)).toBeUndefined()
    expect(parseCachedVerdict(null)).toBeUndefined()
  })

  test("a cached escalation verdict replays escalate/reason with cached: true", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.6 } })) // confidence 0.2
    const d = deps(judge)
    const call: DecideCall = { state: "s", questions: qa, escalateBelow: 0.5 }
    const first = (await runDecide(d, call)) as DecideVerdict
    expect(first.escalate).toBe(true)
    const second = (await runDecide(d, call)) as DecideVerdict
    expect(second.cached).toBe(true)
    expect(second.escalate).toBe(true)
    expect(second.reason).toBe(first.reason)
    expect(judge.calls).toHaveLength(1)
  })

  test("choice questions accept null descriptions and p === 0.5 noul picks true", async () => {
    const judge = createJudge(() =>
      answers({
        a: { type: "noul", noul: 0.5 },
        c: { type: "choice", choice: "auth", confidence: 1, probabilities: { auth: 1, db: 0 } },
      }),
    )
    const out = (await runDecide(deps(judge), {
      state: "s",
      questions: [qa, { mode: "choice", id: "c", options: { auth: null, db: "db" } }],
      cache: false,
    })) as DecideVerdict[]
    expect(out[0]!.value).toBe(true)
    expect(out[0]!.confidence).toBe(0)
    expect(out[1]!.value).toBe("auth")
    expect(out[1]!.confidence).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * (f) API error → throws, no verdict
 * ------------------------------------------------------------------ */

describe("fail loud", () => {
  test("a judge error throws and no verdict is produced", async () => {
    const judge = createJudge(() => {
      throw new Error("decide: Jev request failed (HTTP 500): upstream exploded")
    })
    await expect(runDecide(deps(judge), { state: "s", questions: qa, cache: false })).rejects.toThrow(
      /HTTP 500/,
    )
  })

  test("a non-Error rejection still becomes an Error", async () => {
    const judge: Judge = {
      modelId: "x",
      async systemOne() {
        throw "boom"
      },
    }
    await expect(runDecide(deps(judge), { state: "s", questions: qa, cache: false })).rejects.toThrow(
      /judge request failed: boom/,
    )
  })

  test("a malformed judge response throws", async () => {
    const judge = createJudge(() => ({ model: "x" } as unknown as SystemOneResult))
    await expect(runDecide(deps(judge), { state: "s", questions: qa, cache: false })).rejects.toThrow(
      /malformed response/,
    )
  })
})

/* ------------------------------------------------------------------ *
 * (g) decision log
 * ------------------------------------------------------------------ */

describe("decision log", () => {
  test("exactly one entry per request, with the contract shape", async () => {
    const judge = createJudge(() =>
      answers({
        a: { type: "noul", noul: 0.9 },
        b: { type: "score", score: 2, confidence: 0.8 },
      }),
    )
    const { entries, log } = createLog()
    const d: EngineDeps = { ...deps(judge, log) }

    await runDecide(d, { state: "s", questions: [qa, qb], cache: false })
    expect(entries).toHaveLength(1)
    const entry = entries[0] as Record<string, unknown>
    expect(entry.at).toBe(1000)
    expect(entry.modelId).toBe("jev-response")
    expect(entry.latencyMs).toBe(0)
    expect(entry.cached).toBe(false)
    expect(entry.questionIds).toEqual(["a", "b"])
    expect(Array.isArray(entry.verdicts)).toBe(true)
    expect((entry.verdicts as DecideVerdict[]).map((v) => v.id)).toEqual(["a", "b"])
    expect(entry.usage).toEqual({ input_tokens: 11, output_tokens: 7 })

    // The entry must be JSON-safe.
    expect(() => JSON.stringify(entry)).not.toThrow()
  })

  test("an all-cached batch logs one cached entry with latency 0", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } }))
    const { entries, log } = createLog()
    const d: EngineDeps = { ...deps(judge, log) }
    await runDecide(d, { state: "s", questions: qa })
    await runDecide(d, { state: "s", questions: qa })
    expect(entries).toHaveLength(2)
    expect((entries[1] as Record<string, unknown>).cached).toBe(true)
    expect((entries[1] as Record<string, unknown>).latencyMs).toBe(0)
    expect(judge.calls).toHaveLength(1)
  })

  test("a throwing log sink never breaks the caller", async () => {
    const judge = createJudge(() => answers({ a: { type: "noul", noul: 0.9 } }))
    const d: EngineDeps = {
      ...deps(judge),
      log: () => {
        throw new Error("log sink down")
      },
    }
    const out = (await runDecide(d, { state: "s", questions: qa, cache: false })) as DecideVerdict
    expect(out.value).toBe(true)
  })

  test("latencyMs reflects the judge call when the clock advances", async () => {
    let clock = 500
    const judge = createJudge(() => {
      clock += 25
      return answers({ a: { type: "noul", noul: 0.9 } })
    })
    const d: EngineDeps = { judge, storage: createStorage(), now: () => clock }
    const out = (await runDecide(d, { state: "s", questions: qa })) as DecideVerdict
    expect(out.latencyMs).toBe(25)
    expect(out.modelId).toBe("jev-response")
  })
})
