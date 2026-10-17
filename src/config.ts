/**
 * Feature C — runtime configuration for the Code Mode `decide` plugin.
 *
 * OWNER: worker C. Contract: `docs/CONTRACTS.md` §3.
 *
 * `loadConfig` is pure: it only reads (`env`, `.env` files, `auth.json`). It never writes,
 * never calls `process.exit`, and never throws — a missing/unreadable/malformed `auth.json`
 * simply yields `apiKeySource: "none"`.
 *
 * The resolved API key lives in `apiKey` and nowhere else. It is never logged, and no other
 * field of `DecideConfig` contains it.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// Worker B owns `src/builtins.ts` (§2); the default built-in id list is defined there.
import { BUILTIN_FILE_SHELL_IDS } from "./builtins.ts"

/** Liquid AI systemone endpoint (wire-compatible with the TypeSafe systemone shape). */
export const DEFAULT_BASE_URL = "https://api.liquid.ai/decisions"
/** Pinned model id. */
export const DEFAULT_MODEL = "d1-ultra"

/**
 * API-key env names, in precedence order. Liquid first (the default backend), then the legacy
 * OpenCode/TypeSafe names so an existing checkout keeps working if someone pins them.
 */
const KEY_ENV_NAMES = ["LIQUID_AI_API_KEY", "LIQUID_API_KEY", "OPENCODE_API_KEY", "TYPESAFE_API_KEY"] as const

export type ApiKeySource = "env" | "env-file" | "auth-json" | "options" | "none"

export interface DecideConfig {
  apiKey: string | undefined
  apiKeySource: ApiKeySource
  baseURL: string
  model: string
  builtinsCodemode: boolean
  builtinIds: string[]
  /** The `.env` actually read, if any. */
  envFile: string | undefined
  hintEnabled: boolean
}

/** Per-field overrides; only `apiKey` is named by the contract (`input.overrides.apiKey`). */
export interface DecideConfigOverrides {
  apiKey?: string
  baseURL?: string
  model?: string
  builtinsCodemode?: boolean
  builtinIds?: readonly string[]
  hintEnabled?: boolean
}

export interface LoadConfigInput {
  /** Environment map. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Accepted for the frozen `§3` signature, but no longer consulted: the env file is resolved
   * from `configDir` alone (see `resolveEnvFile`).
   */
  directory?: string
  /** Defaults to `OPENCODE_CONFIG_DIR`, then `~/.config/opencode`. */
  configDir?: string
  /** Defaults to the `auth.json` under `configDir` (see `authJsonCandidates`). */
  authJsonPath?: string
  /** Internal overrides, used by `src/index.ts`. */
  overrides?: DecideConfigOverrides
}

/* ------------------------------------------------------------------ *
 * value parsing
 * ------------------------------------------------------------------ */

/** Trimmed value, or `undefined` when absent/empty/whitespace. */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])
const FALSE_VALUES = new Set(["0", "false", "no", "off"])

/** `1`/`true`/`yes` → true, `0`/`false`/`no` → false, anything else → `undefined`. */
export function parseBoolFlag(value: string | undefined): boolean | undefined {
  const normalized = nonEmpty(value)?.toLowerCase()
  if (normalized === undefined) return undefined
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return undefined
}

/** Comma list → trimmed, non-empty entries. Absent/empty list → `undefined`. */
export function parseIdList(value: string | undefined): string[] | undefined {
  const raw = nonEmpty(value)
  if (raw === undefined) return undefined
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")
  return ids.length > 0 ? ids : undefined
}

/**
 * One `.env` value: surrounding single/double quotes are stripped (verbatim inside), an
 * unquoted value is trimmed and a whitespace-preceded `#…` inline comment is dropped.
 * No escape processing.
 */
function parseEnvValue(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    return end === -1 ? value.slice(1) : value.slice(1, end)
  }
  return value.replace(/\s+#.*$/s, "").trim()
}

/**
 * Parse `.env` text: `KEY=VALUE` lines, `#` comments (whole-line and trailing), optional
 * single/double quotes, an optional `export ` prefix, blank lines and CRLF ignored.
 * Later duplicates win, mirroring dotenv.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const body = line.replace(/^export\s+/, "")
    const eq = body.indexOf("=")
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (key === "") continue
    values[key] = parseEnvValue(body.slice(eq + 1))
  }
  return values
}

/* ------------------------------------------------------------------ *
 * reads (never throw)
 * ------------------------------------------------------------------ */

function readEnvFileValues(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

/** `auth.json` → `opencode.key`; any problem (missing, unreadable, malformed) ⇒ `undefined`. */
function readAuthJsonKey(path: string): string | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof doc !== "object" || doc === null) return undefined
    const opencode = (doc as Record<string, unknown>)["opencode"]
    if (typeof opencode !== "object" || opencode === null) return undefined
    const key = (opencode as Record<string, unknown>)["key"]
    return typeof key === "string" ? nonEmpty(key) : undefined
  } catch {
    return undefined
  }
}

/**
 * Default `auth.json` candidates, literal contract path first.
 *
 * Contract §3 documents `<configDir>/../.local/share/opencode/auth.json` while `configDir`
 * defaults to `~/.config/opencode`, which makes the literal path `~/.config/.local/…` — one
 * level above the real OpenCode location. Both are probed, literal first, so the documented
 * path wins whenever it exists and the dev fallback still works with the default config dir.
 */
function authJsonCandidates(configDir: string): string[] {
  const literal = resolve(configDir, "../.local/share/opencode/auth.json")
  const real = resolve(configDir, "../../.local/share/opencode/auth.json")
  return literal === real ? [literal] : [literal, real]
}

/**
 * The `.env` to read: `OPENCODE_DECIDE_ENV_FILE` → `<configDir>/.env`
 * (default `~/.config/opencode/.env`). First existing candidate wins; a configured-but-missing
 * path falls through.
 *
 * The global config-dir file is deliberately the *only* implicit candidate. A project's own
 * `<directory>/.env` is usually unrelated to this plugin (an app's secrets), and with
 * "first existing wins" it silently shadowed the global switch: a session in any project that
 * happens to ship a `.env` lost `OPENCODE_DECIDE_BUILTINS_CODEMODE=1`, so the built-ins stayed
 * out of Code Mode (observed live 2026-10-16 in `/home/rp/chat`). A project that genuinely needs
 * its own values points `OPENCODE_DECIDE_ENV_FILE` at them.
 */
function resolveEnvFile(input: {
  env: Record<string, string | undefined>
  configDir: string
}): string | undefined {
  const explicit = nonEmpty(input.env["OPENCODE_DECIDE_ENV_FILE"])
  const candidates = [
    explicit === undefined ? undefined : resolve(explicit),
    join(input.configDir, ".env"),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * loadConfig
 * ------------------------------------------------------------------ */

export function loadConfig(input: LoadConfigInput = {}): DecideConfig {
  const env = input.env ?? process.env
  const overrides = input.overrides ?? {}

  const configDir =
    nonEmpty(input.configDir) ??
    nonEmpty(env["OPENCODE_CONFIG_DIR"]) ??
    join(homedir(), ".config", "opencode")

  const envFile = resolveEnvFile({ env, configDir })
  const fileValues = envFile === undefined ? {} : readEnvFileValues(envFile)

  /** Explicit env var wins over the same key in the `.env` file; empty counts as absent. */
  const effective = (key: string): string | undefined =>
    nonEmpty(env[key]) ?? nonEmpty(fileValues[key])

  // 1. explicit override → 2. process env → 3. env file → 4. auth.json → none
  const overrideKey = nonEmpty(overrides.apiKey)
  const firstPresent = (source: (name: string) => string | undefined): string | undefined => {
    for (const name of KEY_ENV_NAMES) {
      const value = source(name)
      if (value !== undefined) return value
    }
    return undefined
  }
  const envKey = firstPresent((name) => nonEmpty(env[name]))
  const fileKey = firstPresent((name) => nonEmpty(fileValues[name]))
  const allowAuthJson =
    (parseBoolFlag(effective("OPENCODE_DECIDE_ALLOW_AUTH_JSON")) ?? true) === true

  let apiKey: string | undefined
  let apiKeySource: ApiKeySource = "none"
  if (overrideKey !== undefined) {
    apiKey = overrideKey
    apiKeySource = "options"
  } else if (envKey !== undefined) {
    apiKey = envKey
    apiKeySource = "env"
  } else if (fileKey !== undefined) {
    apiKey = fileKey
    apiKeySource = "env-file"
  } else if (allowAuthJson) {
    const authPath = nonEmpty(input.authJsonPath)
    const candidates = authPath !== undefined ? [authPath] : authJsonCandidates(configDir)
    for (const candidate of candidates) {
      const key = readAuthJsonKey(candidate)
      if (key !== undefined) {
        apiKey = key
        apiKeySource = "auth-json"
        break
      }
    }
  }

  return {
    apiKey,
    apiKeySource,
    baseURL:
      nonEmpty(overrides.baseURL) ?? effective("OPENCODE_DECIDE_BASE_URL") ?? DEFAULT_BASE_URL,
    model: nonEmpty(overrides.model) ?? effective("OPENCODE_DECIDE_MODEL") ?? DEFAULT_MODEL,
    builtinsCodemode:
      overrides.builtinsCodemode ??
      parseBoolFlag(effective("OPENCODE_DECIDE_BUILTINS_CODEMODE")) ??
      false,
    builtinIds:
      overrides.builtinIds !== undefined
        ? [...overrides.builtinIds]
        : (parseIdList(effective("OPENCODE_DECIDE_BUILTIN_IDS")) ?? [...BUILTIN_FILE_SHELL_IDS]),
    envFile,
    hintEnabled:
      overrides.hintEnabled ?? parseBoolFlag(effective("OPENCODE_DECIDE_HINT")) ?? true,
  }
}
