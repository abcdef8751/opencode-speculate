/**
 * The `@typesafe-ai/sdk`-backed `Judge`, pointed at the OpenCode Console systemone endpoint.
 *
 * Verified live (2026-10-16): the SDK posts `{model, state, questions}` to
 * `<baseURL>/v1/systemone` with `Authorization: Bearer <apiKey>`, and the Console Jev endpoint
 * answers with `{model, answers, usage}`. Cloudflare 1010-blocks unknown User-Agents on that
 * host, so we must never set a custom UA; the SDK's own UA is fine. `compression: false` avoids
 * the unverified zstd path.
 */

import { APIError, TypeSafeClient } from "@typesafe-ai/sdk"
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

/** True for the SDK's HTTP error shape, without depending on `instanceof` across copies. */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof APIError) return err.status
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status
    if (typeof status === "number" && Number.isInteger(status)) return status
  }
  return undefined
}

/** Fail loud, but keep the HTTP status (when there is one) in the message for the caller. */
function describeError(err: unknown): Error {
  const status = httpStatusOf(err)
  const message =
    err instanceof Error && err.message
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown error"
  if (status !== undefined) {
    return new Error(`decide: Jev request failed (HTTP ${status}): ${message}`)
  }
  return new Error(`decide: Jev request failed: ${message}`)
}

function normalizeUsage(usage: SystemOneResult["usage"]): SystemOneUsage {
  return {
    input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
  }
}

/** `@typesafe-ai/sdk`-backed `Judge` pointed at the OpenCode Console systemone endpoint. */
export function createJevJudge(opts: CreateJevJudgeOptions): Judge {
  const apiKey = opts.apiKey
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      "decide: createJevJudge requires an apiKey (resolved from the environment, never logged)",
    )
  }
  const baseURL = opts.baseURL ?? DEFAULT_JEV_BASE_URL
  const model = opts.model ?? DEFAULT_JEV_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS

  const client = new TypeSafeClient({
    apiKey,
    baseURL,
    defaultModel: model,
    compression: false,
    timeout: timeoutMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })

  return {
    modelId: model,
    async systemOne(
      req: SystemOneRequest,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<SystemOneResult> {
      try {
        const result = await client.systemOne(
          // The SDK's question/state types are structurally the same JSON we build; it is the
          // engine's job to keep the shapes honest, the judge's job to transport them.
          req as unknown as Parameters<TypeSafeClient["systemOne"]>[0],
          {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(typeof options?.timeoutMs === "number"
              ? { timeout: options.timeoutMs }
              : {}),
          },
        )
        return {
          model: result.model,
          answers: (result.answers ?? {}) as unknown as Record<string, SystemOneAnswer>,
          usage: normalizeUsage(result.usage),
        }
      } catch (err) {
        throw describeError(err)
      }
    },
  }
}
