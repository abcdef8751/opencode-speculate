/**
 * The Jev `Judge` — a dependency-free `fetch` client for the OpenCode Console systemone endpoint.
 *
 * IMPORTANT: `@typesafe-ai/sdk` is deliberately NOT used here. `docs/CONTRACTS.md` records two
 * measured failures on this host: (1) the SDK's `bufferResponse()` drains `response.clone()` and
 * then `.text()`s the same response, which throws `TypeError: Body already used` under Bun once the
 * request state grows past a few KB; (2) the Console endpoint rejects the SDK's zstd request
 * compression. A plain `fetch` client works at every size.
 *
 * Verified live (2026-10-16): `POST <baseURL>/v1/systemone`, `Authorization: Bearer <apiKey>`,
 * body `{model, state, questions}`, response `{model, answers, usage}`. Cloudflare 1010-blocks
 * unknown User-Agents, so we send a normal `<product>/<version>` UA.
 */

import type {
  Judge,
  SystemOneAnswer,
  SystemOneRequest,
  SystemOneResult,
  SystemOneUsage,
} from "./types"

export const DEFAULT_JEV_BASE_URL = "https://opencode.ai/inference/systemone"
export const DEFAULT_JEV_MODEL = "jev-1.13-free"
export const DEFAULT_JEV_TIMEOUT_MS = 10_000
/** Any `<product>/<version>` string gets past Cloudflare; a missing one is 1010-blocked. */
export const JEV_USER_AGENT = "opencode-codemode-decide/0.1.0"

export interface CreateJevJudgeOptions {
  apiKey: string
  /** Default `https://opencode.ai/inference/systemone`. */
  baseURL?: string
  /** Default `jev-1.13-free`. Pin a versioned id; aliases drift. */
  model?: string
  /** Default `10000`. */
  timeoutMs?: number
  /** Inject a `fetch` for tests. The real endpoint is never called from tests. */
  fetch?: typeof fetch
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

/** Jev `Judge`: dependency-free `fetch` client (NOT the SDK — see the finding in the contract). */
export function createJevJudge(opts: CreateJevJudgeOptions): Judge {
  const apiKey = opts.apiKey
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      "decide: createJevJudge requires an apiKey (resolved from the environment, never logged)",
    )
  }
  const baseURL = stripTrailingSlashes(opts.baseURL ?? DEFAULT_JEV_BASE_URL)
  const model = opts.model ?? DEFAULT_JEV_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS
  const doFetch = opts.fetch ?? globalThis.fetch
  if (typeof doFetch !== "function") {
    throw new Error("decide: createJevJudge requires a fetch implementation")
  }

  return {
    modelId: model,
    async systemOne(
      req: SystemOneRequest,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<SystemOneResult> {
      const effectiveTimeout =
        typeof options?.timeoutMs === "number" ? options.timeoutMs : timeoutMs
      const callerSignal = options?.signal

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, effectiveTimeout)
      const abortFromCaller = (): void => controller.abort()
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort()
        else callerSignal.addEventListener("abort", abortFromCaller, { once: true })
      }

      try {
        const response = await doFetch(`${baseURL}/v1/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            // Never omit or customise this: Cloudflare 1010-bans unknown User-Agents.
            "User-Agent": JEV_USER_AGENT,
          },
          body: JSON.stringify({
            model: req.model ?? model,
            state: req.state,
            questions: req.questions,
          }),
          signal: controller.signal,
        })

        const text = await response.text()
        if (!response.ok) {
          throw new Error(
            `Jev request failed: HTTP ${response.status} ${response.statusText} — ${text.slice(0, 300)}`,
          )
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error(`Jev returned a non-JSON response: ${text.slice(0, 300)}`)
        }
        if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) {
          throw new Error("Jev returned an unusable response")
        }

        const usage: SystemOneUsage | undefined = isPlainObject(parsed.usage)
          ? {
              input_tokens: numberOrNull(parsed.usage.input_tokens),
              output_tokens: numberOrNull(parsed.usage.output_tokens),
            }
          : undefined

        return {
          model: typeof parsed.model === "string" ? parsed.model : model,
          answers: parsed.answers as unknown as Record<string, SystemOneAnswer>,
          ...(usage ? { usage } : {}),
        }
      } catch (err) {
        if (timedOut) {
          throw new Error(`Jev request failed: timeout after ${effectiveTimeout}ms`)
        }
        if (callerSignal?.aborted) {
          throw new Error("Jev request failed: aborted by caller")
        }
        throw err instanceof Error ? err : new Error(`Jev request failed: ${String(err)}`)
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener("abort", abortFromCaller)
      }
    },
  }
}
