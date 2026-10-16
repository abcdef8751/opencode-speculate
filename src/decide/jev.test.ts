import { describe, expect, test } from "bun:test"
import { createJevJudge, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from "./jev"
import type { SystemOneRequest } from "./types"

/**
 * A duck-typed Response so the SDK's `bufferResponse` (which calls `response.clone()` and
 * `response.body.getReader()`) does not trip Bun's "Body already used" clone quirk. No network.
 */
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  const headers = new Headers({ "content-type": "application/json" })
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: null,
    clone(): Response {
      return this as unknown as Response
    },
    async text(): Promise<string> {
      return text
    },
  } as unknown as Response
}

interface Captured {
  url: string
  init: RequestInit
}

function capturingFetch(respond: () => Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const question = { q: { type: "noul" as const, instructions: "is it?", criteria: { true: "y", false: "n" } } }

describe("createJevJudge", () => {
  test("posts the OpenCode Console endpoint with the SDK shape and maps the response", async () => {
    const { fetch, calls } = capturingFetch(() =>
      jsonResponse({
        model: "jev-1.13-free",
        answers: { q: { type: "noul", noul: 0.96 } },
        usage: { input_tokens: 409, output_tokens: 73 },
      }),
    )
    const judge = createJevJudge({ apiKey: "test-key", fetch })

    const result = await judge.systemOne({ state: "hello", questions: question })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${DEFAULT_JEV_BASE_URL}/v1/systemone`)
    expect(calls[0]!.init.method).toBe("POST")
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get("authorization")).toBe("Bearer test-key")
    // Never a custom UA: Cloudflare 1010-blocks unknown agents on this host.
    expect(headers.get("user-agent")).toMatch(/^typesafe-sdk\//)
    // compression: false ⇒ no request-body compression header.
    expect(headers.get("content-encoding")).toBeNull()

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.state).toBe("hello")
    expect(body.model).toBe(DEFAULT_JEV_MODEL)
    expect(body.questions).toEqual(question)

    expect(result.model).toBe("jev-1.13-free")
    expect(result.answers.q?.noul).toBe(0.96)
    expect(result.usage).toEqual({ input_tokens: 409, output_tokens: 73 })
  })

  test("honours baseURL/model overrides and a per-call model", async () => {
    const { fetch, calls } = capturingFetch(() =>
      jsonResponse({ model: "custom", answers: {}, usage: { input_tokens: null, output_tokens: null } }),
    )
    const judge = createJevJudge({
      apiKey: "k",
      baseURL: "https://example.test/inference/systemone",
      model: "jev-pinned",
      fetch,
    })
    expect(judge.modelId).toBe("jev-pinned")

    await judge.systemOne({ state: "s", questions: question, model: "jev-loose" })
    expect(calls[0]!.url).toBe("https://example.test/inference/systemone/v1/systemone")
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe("jev-loose")
  })

  test("an HTTP error throws an Error whose message includes the status", async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ error: { message: "bad key" } }, 401))
    const judge = createJevJudge({ apiKey: "k", fetch, timeoutMs: 200 })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/HTTP 401/)
  })

  test("a non-retryable 4xx error surfaces the status too", async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ error: { message: "bad request" } }, 400))
    const judge = createJevJudge({ apiKey: "k", fetch })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/HTTP 400/)
  })

  test("requires an apiKey", () => {
    expect(() => createJevJudge({ apiKey: "" })).toThrow(/apiKey/)
  })
})
