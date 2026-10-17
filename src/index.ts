/**
 * OpenCode V2 plugin entry — orchestrator-owned integration wiring.
 *
 * Responsibilities (plan steps 1–3):
 *   1. register `decide` as a pinned, Code-Mode-only plugin tool in the `typesafe` namespace
 *   2. inject the session-context hint that teaches the ≈3-line escalation handler
 *   3. optionally flip `options.codemode` on the file/shell built-ins (default: OFF)
 *   4. write one durable decision-log entry per `decide` call via the tool hook
 *
 * Every collaborating module is imported through its frozen public surface
 * (`docs/CONTRACTS.md` §1–§3).
 */

import { createHash } from "node:crypto"

import { Plugin } from "@opencode/plugin"
import {
  createDecideTool,
  createSystemOneJudge,
  DECIDE_NAMESPACE,
  DECIDE_TOOL_NAME,
  type Json,
  type StoragePort,
} from "./decide/index.ts"
import { enableBuiltinsForCodeMode } from "./builtins.ts"
import { loadConfig } from "./config.ts"
import { decideHint } from "./hint.ts"

/**
 * Storage keys.
 *
 * `decide/log/…`  — the contract §1 decision log: one entry per `decide` call, emitted by the
 *                   engine's `log` sink, keyed `decide/log/<iso>-<sha8>`.
 * `decide/audit/…` — an *additional* session-scoped audit record written from the tool hook
 *                   (`execute.after`), which is the only place a `sessionID` is available. It
 *                   lives under a distinct prefix so the two record shapes can never be confused.
 */
const LOG_PREFIX = "decide/log/"
const AUDIT_PREFIX = "decide/audit/"

/** Structural view of the host's tool editor (see `docs/CONTRACTS.md` §2). */
interface EditorLike {
  update(id: string, fn: (tool: { options?: Record<string, unknown> | null }) => void): void
}

export default Plugin.define({
  id: "codemode-decide",
  async setup(ctx) {
    const config = loadConfig({ directory: ctx.location.directory })

    // Boundary adapter: the host storage speaks `effect/Schema.Json`, whose arrays are
    // `readonly`; the contract's `Json` uses mutable arrays. Values are plain JSON either way.
    const storage: StoragePort = {
      get: async (key) => (await ctx.storage.get(key)) as Json | undefined,
      set: async (key, value) => {
        await ctx.storage.set(key, value as never)
      },
    }

    const judge = config.apiKey
      ? createSystemOneJudge({ apiKey: config.apiKey, baseURL: config.baseURL, model: config.model })
      : undefined

    if (judge === undefined) {
      console.error(
        `[decide] no API key (source: ${config.apiKeySource}) — decide tool not registered. ` +
          `Set LIQUID_AI_API_KEY in .env (see .env.example).`,
      )
    }

    let flipReport: ReturnType<typeof enableBuiltinsForCodeMode> | undefined

    /**
     * Contract §1 decision log: the engine emits one entry per `decide` call (a full cache hit
     * included); we persist it verbatim (that frozen shape is what consumers read) under
     * `decide/log/<iso>-<sha8>`. A sink must never throw into the caller path, so failures are
     * swallowed to the log.
     */
    const writeDecisionLog = async (entry: Json): Promise<void> => {
      try {
        const at = typeof (entry as { at?: unknown })?.at === "number" ? (entry as { at: number }).at : Date.now()
        const iso = new Date(at).toISOString()
        const digest = createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 8)
        const base = `${LOG_PREFIX}${iso}-${digest}`.replace(/[:.]/g, "-")
        // Two byte-identical entries in the same millisecond would collide; suffix instead of
        // silently overwriting an earlier record (contract §1).
        let key = base
        for (let n = 1; (await storage.get(key)) !== undefined && n <= 5; n++) key = `${base}-${n}`
        await storage.set(key, entry)
      } catch (error) {
        console.error(`[decide] decision log write failed: ${String(error)}`)
      }
    }

    const registration = await ctx.tool.transform((editor) => {
      // --- built-ins into Code Mode (contract §2 call-site adapter) ---
      flipReport = enableBuiltinsForCodeMode(
        {
          list: () => editor.list(),
          update: (id, fn) =>
            editor.update(id, (tool) => {
              fn(tool as unknown as { options?: Record<string, unknown> | null })
            }),
        },
        { enabled: config.builtinsCodemode, ids: config.builtinIds },
      )

      // --- the decide tool (contract §1) ---
      if (judge !== undefined) {
        editor.namespace({ name: DECIDE_NAMESPACE, description: "Liquid d1-ultra fast structured decisions" })
        editor.add(
          // Boundary cast: the tool surface is structurally identical; the host's generics are
          // stricter than the structural mirror in `decide/index.ts` (contract §2 pattern).
          createDecideTool({ judge, storage, log: writeDecisionLog }) as unknown as Parameters<
            typeof editor.add
          >[0],
        )
      }
    })

    if (config.builtinsCodemode || (flipReport?.skipped.length ?? 0) > 0) {
      const r = flipReport
      console.error(
        `[decide] built-ins→CodeMode enabled=${config.builtinsCodemode} ` +
          `flipped=[${r?.flipped.join(",") ?? ""}] already=[${r?.already.join(",") ?? ""}] ` +
          `skipped=[${r?.skipped.map((s) => `${s.id}:${s.reason}`).join(",") ?? ""}]`,
      )
    }

    // --- session hint (plan step 2) ---
    const hintRegistration =
      config.hintEnabled && judge !== undefined
        ? await ctx.session.hook("context", (raw) => {
            const event = raw as unknown as {
              sessionID?: string
              system?: { type: string; text: string }[]
            }
            if (!event?.sessionID || !Array.isArray(event.system)) return
            event.system.push({ type: "text", text: decideHint(config) })
          })
        : undefined

    // --- session-scoped audit record (the tool hook is the only place a sessionID exists) ---
    const logRegistration = await ctx.tool.hook("execute.after", async (raw) => {
      const event = raw as unknown as {
        tool: string
        sessionID: string
        id: string
        input: unknown
        status: "completed" | "error"
        result?: { output?: unknown }
        error?: { message?: unknown }
      }
      // The host may report a namespaced tool name (`typesafe.decide`) or the bare one. Guard the
      // type: the event is cast, not validated, and `.endsWith` on a non-string would throw here —
      // outside the try/catch below.
      const tool = typeof event.tool === "string" ? event.tool : ""
      if (tool !== DECIDE_TOOL_NAME && !tool.endsWith(`.${DECIDE_TOOL_NAME}`)) return
      const at = new Date().toISOString()
      const key = `${AUDIT_PREFIX}${at}-${event.id}`.replace(/[:.]/g, "-")
      try {
        await ctx.storage.set(key, {
          at,
          sessionID: event.sessionID,
          callID: event.id,
          status: event.status,
          modelId: judge?.modelId ?? null,
          input: event.input as never,
          verdicts: (event.status === "completed" ? event.result?.output ?? null : null) as never,
          error:
            event.status === "error"
              ? String(event.error?.message ?? event.error ?? "unknown error")
              : null,
        })
      } catch (error) {
        console.error(`[decide] audit record write failed: ${String(error)}`)
      }
    })

    return async () => {
      await logRegistration.dispose()
      if (hintRegistration !== undefined) await hintRegistration.dispose()
      await registration.dispose()
    }
  },
})
