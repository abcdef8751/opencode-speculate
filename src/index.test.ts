/**
 * Integration test for the plugin entry — orchestrator-owned wiring.
 *
 * Exercises the real `setup()` against a fake OpenCode V2 context: the tool transform, the
 * session hint, the durable decision log, and (through the stubbed network) the whole
 * `tools.typesafe.decide` path. Nothing here touches the real Jev endpoint.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "./index.ts"

interface Registered {
  name: string
  options?: { namespace?: string; codemode?: boolean; pinned?: boolean }
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  execute?: (input: unknown, context?: unknown) => Promise<{ output?: unknown; content?: unknown }>
}

const realFetch = globalThis.fetch
const realEnv = { ...process.env }
let configDir: string

function fakeSystemOneResponse(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 5 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** Minimal fake of the V2 plugin context surface `setup()` uses. */
function fakeContext() {
  const registered: Registered[] = []
  const namespaces: { name: string; description: string }[] = []
  const store = new Map<string, unknown>()
  const contextHooks: ((raw: unknown) => void)[] = []
  const afterHooks: ((raw: unknown) => Promise<void> | void)[] = []
  const list = [
    { id: "read", options: { codemode: false } },
    { id: "shell", options: { codemode: false } },
  ]

  const ctx = {
    location: { directory: "/tmp/fake-project" },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          list: () => list,
          update: (id: string, fn: (t: { options?: Record<string, unknown> | null }) => void) => {
            const tool = list.find((t) => t.id === id)
            if (tool) fn(tool)
          },
          namespace: (ns: { name: string; description: string }) => namespaces.push(ns),
          add: (def: Registered) => registered.push(def),
          get: (id: string) => list.find((t) => t.id === id),
          remove: () => void 0,
        })
      },
      hook: async (name: string, cb: (raw: unknown) => Promise<void> | void) => {
        if (name === "execute.after") afterHooks.push(cb)
        return { dispose: async () => void 0 }
      },
    },
    session: {
      hook: async (name: string, cb: (raw: unknown) => void) => {
        if (name === "context") contextHooks.push(cb)
        return { dispose: async () => void 0 }
      },
    },
  }
  return { ctx, registered, namespaces, store, contextHooks, afterHooks, list }
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "decide-cfg-"))
  process.env = {
    ...realEnv,
    OPENCODE_API_KEY: "test-key",
    OPENCODE_CONFIG_DIR: configDir, // never read the user's real config dir
    OPENCODE_DECIDE_ALLOW_AUTH_JSON: "0",
    OPENCODE_DECIDE_MODEL: "jev-test",
    OPENCODE_DECIDE_ENV_FILE: join(configDir, "absent.env"),
    OPENCODE_DECIDE_BUILTINS_CODEMODE: "0",
  }
})

afterEach(() => {
  process.env = { ...realEnv }
  globalThis.fetch = realFetch
  rmSync(configDir, { recursive: true, force: true })
})

describe("plugin setup()", () => {
  test("registers exactly one pinned, Code-Mode-only decide tool in the typesafe namespace", async () => {
    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)

    expect(f.registered).toHaveLength(1)
    const tool = f.registered[0]!
    expect(tool.name).toBe("decide")
    expect(tool.options).toEqual({ namespace: "typesafe", codemode: true, pinned: true })
    expect(tool.input).toBeDefined()
    expect(tool.output).toBeDefined()
    expect(f.namespaces.map((n) => n.name)).toEqual(["typesafe"])
  })

  test("injects a hint that teaches the Code Mode path and the escalation handler", async () => {
    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    expect(f.contextHooks).toHaveLength(1)

    const event = { sessionID: "ses_test", system: [] as { type: string; text: string }[] }
    f.contextHooks[0]!(event)

    expect(event.system).toHaveLength(1)
    const text = event.system[0]!.text
    expect(text).toContain("tools.typesafe.decide")
    expect(text).toContain("escalate")
    expect(text).toContain("break")
    expect(text).toContain("search(")
  })

  test("decide() runs end-to-end through the registered tool and logs one entry", async () => {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, unknown> }
      calls.push({ url: String(url), body })
      return fakeSystemOneResponse({
        passed: { type: "noul", noul: 0.97 },
        culprit: {
          type: "choice",
          choice: "src/auth.ts",
          confidence: 0.9,
          probabilities: { "src/auth.ts": 0.9, "src/db.ts": 0.1 },
        },
      })
    }) as unknown as typeof fetch

    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    const tool = f.registered[0]!

    const result = (await tool.execute!(
      {
        state: "FAIL src/auth.test.ts — expected 401, got 200",
        questions: [
          {
            mode: "noul",
            id: "passed",
            criterion: "the test run passed cleanly",
            criteria: { true: "all tests passed", false: "any failure" },
          },
          {
            mode: "choice",
            id: "culprit",
            criterion: "which module owns the first failure",
            options: { "src/auth.ts": "the auth module", "src/db.ts": "the database layer" },
          },
        ],
      },
      { sessionID: "ses_test" },
    )) as { output: { id: string; value: unknown; confidence: number }[]; content: string }

    // one Jev request for the whole batch
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://opencode.ai/inference/systemone/v1/systemone")

    expect(result.output.map((v) => v.id)).toEqual(["passed", "culprit"])
    expect(result.output[0]!.value).toBe(true)
    expect(result.output[0]!.confidence).toBeCloseTo(0.94, 5) // |2*0.97-1|
    expect(result.output[1]!.value).toBe("src/auth.ts")
    expect(result.content).toContain("passed")

    // the execute.after hook turns that call into a durable log entry
    await f.afterHooks[0]!({
      tool: "decide",
      sessionID: "ses_test",
      id: "call_1",
      input: { state: "x", questions: [] },
      status: "completed",
      result: { output: result.output },
    })
    const logKeys = [...f.store.keys()].filter((k) => k.startsWith("decide/log/"))
    expect(logKeys).toHaveLength(1)
    const entry = f.store.get(logKeys[0]!) as { sessionID: string; status: string; verdicts: unknown[] }
    expect(entry.sessionID).toBe("ses_test")
    expect(entry.status).toBe("completed")
    expect(entry.verdicts).toHaveLength(2)
  })

  test("a Jev failure surfaces as a thrown error, and still logs an error entry", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 })) as unknown as typeof fetch

    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    const tool = f.registered[0]!

    await expect(
      tool.execute!(
        {
          state: "x",
          questions: [
            { mode: "noul", id: "q", criterion: "c", criteria: { true: "y", false: "n" } },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/401/)

    await f.afterHooks[0]!({
      tool: "decide",
      sessionID: "ses_test",
      id: "call_2",
      input: {},
      status: "error",
      error: { message: "Jev request failed: HTTP 401 Unauthorized" },
    })
    const entry = f.store.get([...f.store.keys()].find((k) => k.startsWith("decide/log/"))!) as {
      status: string
      error: string
    }
    expect(entry.status).toBe("error")
    expect(entry.error).toContain("401")
  })

  test("built-ins stay untouched by default (flip is opt-in)", async () => {
    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    expect(f.list.map((t) => t.options.codemode)).toEqual([false, false])
  })

  test("flips the file/shell built-ins when opted in, and reports what it did", async () => {
    process.env.OPENCODE_DECIDE_BUILTINS_CODEMODE = "1"
    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    expect(f.list.map((t) => t.options.codemode)).toEqual([true, true])
  })

  test("registers nothing and injects no hint when there is no API key", async () => {
    delete process.env.OPENCODE_API_KEY
    const f = fakeContext()
    await (plugin as { setup(ctx: unknown): Promise<unknown> }).setup(f.ctx)
    expect(f.registered).toHaveLength(0)
    expect(f.contextHooks).toHaveLength(0)
  })
})
