import { describe, expect, test } from "bun:test"
import {
  createJevJudge,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  JEV_USER_AGENT,
} from "./jev"

/** A real `Response` is fine now: our client reads the body exactly once. No network. */
function jsonResponse(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  })
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

const question = {
  q: { type: "noul" as const, instructions: "is it?", criteria: { true: "y", false: "n" } },
}

describe("createJevJudge", () => {
  test("posts the OpenCode Console endpoint with the contract headers/body and maps the response", async () => {
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
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("accept")).toBe("application/json")
    // A normal UA: Cloudflare 1010-blocks unknown agents on this host.
    expect(headers.get("user-agent")).toBe(JEV_USER_AGENT)

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
      jsonResponse({ model: "custom", answers: {} }),
    )
    const judge = createJevJudge({
      apiKey: "k",
      baseURL: "https://example.test/inference/systemone/",
      model: "jev-pinned",
      fetch,
    })
    expect(judge.modelId).toBe("jev-pinned")

    await judge.systemOne({ state: "s", questions: question, model: "jev-loose" })
    expect(calls[0]!.url).toBe("https://example.test/inference/systemone/v1/systemone")
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.model).toBe("jev-loose")
  })

  test("an HTTP error throws an Error whose message includes the status and a body snippet", async () => {
    const { fetch } = capturingFetch(() =>
      jsonResponse({ error: { message: "bad key" } }, 401, "Unauthorized"),
    )
    const judge = createJevJudge({ apiKey: "k", fetch, timeoutMs: 200 })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/HTTP 401/)
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/bad key/)
  })

  test("a non-2xx 400 also surfaces the status", async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ message: "nope" }, 400))
    const judge = createJevJudge({ apiKey: "k", fetch })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/HTTP 400/)
  })

  test("an unusable response throws", async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ model: "x", answers: null }))
    const judge = createJevJudge({ apiKey: "k", fetch })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(
      /unusable response/,
    )
  })

  test("a non-JSON response throws", async () => {
    const { fetch } = capturingFetch(
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    )
    const judge = createJevJudge({ apiKey: "k", fetch })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(/non-JSON/)
  })

  test("a timeout aborts the request and names the timeout", async () => {
    const hangingFetch = ((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch
    const judge = createJevJudge({ apiKey: "k", fetch: hangingFetch, timeoutMs: 5 })
    await expect(judge.systemOne({ state: "s", questions: question })).rejects.toThrow(
      /timeout after 5ms/,
    )
  })

  test("a caller AbortSignal aborts the request", async () => {
    const hangingFetch = ((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch
    const judge = createJevJudge({ apiKey: "k", fetch: hangingFetch, timeoutMs: 10_000 })
    const controller = new AbortController()
    const pending = judge.systemOne({ state: "s", questions: question }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted by caller/)
  })

  test("requires an apiKey", () => {
    expect(() => createJevJudge({ apiKey: "" })).toThrow(/apiKey/)
  })
})
