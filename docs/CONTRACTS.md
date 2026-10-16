# Frozen contracts — Code Mode `decide()` v1

Source plan: `~/.opencode/plan/codemode-decide-v1.md` (steps 1–4).
This file is the **only** interface authority for the workers. If an implementation needs a
different signature, the worker stops and reports — it does not change the contract.

Runtime facts verified on this machine (2026-10-16, `opencode v2.0.30`):

- `@opencode/plugin@2.0.30`, `@opencode/codemode@2.0.30`, `@typesafe-ai/sdk@0.7.0`.
- Plugin entry: `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`; optional V1
  `server` field is ignored by V2 (see the vendored ensemble's dual export).
- `ctx.tool.transform(cb)` → `editor.list() | get(id) | update(id, fn) | add(def) | namespace(ns) | remove(id)`.
- `ctx.tool.hook("execute.before" | "execute.after", cb)` →
  `{ tool, sessionID, agent, messageID, id, input, status:"completed"|"error", result?/error? }`.
- `ctx.session.hook("context", cb)` → event `{ sessionID, system: { type, text }[] }`; push to inject.
- `ctx.storage` → `{ get(k) => Promise<Json|undefined>, set(k, v), remove(k), scan({prefix, after?, limit?}) }`.
- `Tool.Info.options` = `{ namespace?: string, permission?: string } & ({ codemode: true, pinned?: boolean } | { codemode: boolean, pinned?: never })`.
- `Tool.Info.input` / `.output` accept Effect Schema, Standard Schema, **or a plain JSON Schema object**.
- Promise-API tool `execute(input, context) => Promise<Tool.Result<Output>>`, where
  `Result = { output?, content?, metadata? }` — `output` is the ephemeral machine value Code Mode
  receives (structured, unparsed), `content` is the durable model-facing record.
- **Jev / TypeSafe via OpenCode Console** (confirmed live, HTTP 200):
  `POST https://opencode.ai/inference/systemone/v1/systemone`, `Authorization: Bearer <OPENCODE_API_KEY>`,
  body `{ model, state, questions: { <id>: { type, instructions?, criteria? } } }`,
  response `{ model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }`.
  Model `jev-1.13-free` is free. Cloudflare bans unknown User-Agents (1010) — always send a
  normal UA; the SDK's `typesafe-sdk/<ver>` UA works.
- The SDK posts to `baseURL + "/v1/systemone"` and sends `Authorization: Bearer <apiKey>`.
  Therefore `baseURL = "https://opencode.ai/inference/systemone"`.

### ⚠ `@typesafe-ai/sdk` is NOT usable in the plugin path (measured 2026-10-16)

Two independent, reproduced problems — so **`createJevJudge` must not use the SDK**:

1. **Bun + large request states ⇒ `TypeError: Body already used`.** The SDK's `attempt()` runs
   `bufferResponse()`, which drains `response.clone()` and then hands the *same* response object
   back for `parseBody()` to `.text()` again. Under Bun (the OpenCode plugin runtime) that breaks
   once the request state grows past a few KB: `state` of 1.2 KB OK, 13 KB `TypeError`, even with
   `retry: { maxRetries: 0 }`; the HTTP response itself is 200. The identical script under Node 26
   succeeds at 13 KB. Reproduce: `node_modules/@typesafe-ai/sdk/dist/index.mjs` lines 821-840
   (`bufferResponse`), 1039-1043 (`if (res.ok) return res`), 1111 (`parseBody`).
2. **The console endpoint rejects the SDK's request compression.** With `compression: "zstd"` the
   same call returns `BadRequestError 400` (empty body). `compression: false` is mandatory here,
   and the SDK only defaults to uncompressed for bodies < 1 KiB.
3. Also note: the SDK's default UA is what got past Cloudflare; a custom client must send a normal
   UA (verified UA: any `<product>/<version>` string, e.g. `opencode-codemode-decide/0.1.0`).

**Required transport: a ~40-line `fetch` client.** Verified working under Bun at every size
(1 B…44 KB state), with a clean error path. Reference implementation (adapt it; keep the `Judge`
shape and the injected-`fetch` testability):

```ts
const res = await fetch(`${baseURL}/v1/systemone`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "opencode-codemode-decide/0.1.0",   // Cloudflare 1010-bans unknown UAs
  },
  body: JSON.stringify({ model: req.model ?? model, state: req.state, questions: req.questions }),
  signal,                                             // AbortController, timer for timeoutMs
})
const text = await res.text()
if (!res.ok) throw new Error(`Jev request failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`)
const parsed = JSON.parse(text)
if (typeof parsed?.answers !== "object" || parsed.answers === null) throw new Error("Jev returned an unusable response")
return parsed
```

`@typesafe-ai/sdk` stays in `package.json` only so an **optional** adapter can be added later
(`createJevJudge({ transport: "sdk" })`) for a Node host; it is not the default and must not be
exercised in tests. Timeout abort produces an `Error` whose message contains `timeout after Nms`;
a bad key produces `Jev request failed: HTTP 401 Unauthorized — …`.

---

## 1. Feature A — `src/decide/**` (owner: worker A)

Public surface, all re-exported from **`src/decide/index.ts`**:

```ts
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

// ---- question DSL: exactly what a model/script writes ----
export interface NoulQuestion   { mode: "noul";   id: string; criterion?: string;
                                  criteria: { true: string; false: string }; escalateBelow?: number }
export interface ChoiceQuestion { mode: "choice"; id: string; criterion?: string;
                                  options: Record<string, string | null>;     escalateBelow?: number }
export interface ScoreQuestion  { mode: "score";  id: string; criterion?: string;
                                  levels: string[];                            escalateBelow?: number }
export type DecideQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

// ---- one call ----
export interface DecideCall {
  state: string | Json                  // Jev `state`
  questions: DecideQuestion | DecideQuestion[]   // single object => single result
  escalateBelow?: number                // default threshold for every question; absent => never escalate
  model?: string                        // override the pinned model id for this call
  cache?: boolean                       // default true
  timeoutMs?: number                    // per-request timeout, default 10000
}

// ---- per-question verdict ----
export interface DecideVerdict {
  id: string
  mode: "noul" | "choice" | "score"
  value: boolean | string | number      // noul => boolean, choice => chosen label, score => expected score
  p?: number                            // noul only: P(true)
  probabilities?: Record<string, number>// choice: keyed by label; score: keyed by level index ("0","1",...)
  confidence: number                    // normalized, see below
  modelId: string
  latencyMs: number
  cached: boolean
  escalate: boolean
  reason?: string                       // present iff escalate === true
}

// ---- return shape is overloaded on input shape ----
//   decide(state, { ...one question })  -> DecideVerdict
//   decide(state, [ q1, q2, ... ])      -> DecideVerdict[]
```

### Rules (binding)

- **Batching.** An array of questions is ONE Jev request (`questions` keyed by `id`).
  Duplicate `id`s in one call are an error (throw).
- **Confidence normalization.**
  - `noul`: `|2p − 1|`.
  - `choice`: `(p_max − 1/n) / (1 − 1/n)` with `n = Object.keys(options).length`; `n === 1` ⇒ `1`.
  - `score`: the API's `confidence` as-is (`null`/absent ⇒ `0`).
  - `value` for `score` is the API's expected `score`; keep the raw number (may be fractional).
- **Escalation.** A question escalates iff its effective threshold
  (`question.escalateBelow ?? call.escalateBelow`) is a finite number **and**
  `confidence < threshold`. Then `escalate: true` and a non-empty `reason` string.
  With no threshold anywhere, `escalate` is always `false` (opt-in; the plan's "advisory" default).
  A second escalation cause: the answer for an id is missing/unusable (`reason` says so).
  `reason` is a short human sentence — it must be JSON-safe and must name the cause.
- **Fail loud.** Any transport/HTTP/parse error **throws** (`Error` with a message that includes
  the HTTP status if any). Never invent a verdict, never default to `false`.
- **Cache.** When `cache !== false`, key = `decide/cache/<sha256 of stable-stringified {state, question}>`,
  stored via the `StoragePort` as JSON containing the verdict **without** `latencyMs`/`cached`.
  A hit returns the cached verdict with `cached: true`, `latencyMs: 0`. A question in a batch may
  hit while its siblings miss — but a **batch request is skipped only if every question hits**.
- **Decision log.** Register one entry per Jev request (not per question) through the injected
  `log` sink: `{ at, modelId, latencyMs, cached, questionIds, verdicts, usage }`, JSON-safe.
  The plugin wires this into `ctx.storage` (keys `decide/log/<iso>-<sha8>`); the harness wires it
  into an in-memory array. Logging never throws into the caller path.

### Factories

```ts
export interface StoragePort {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
}

export interface SystemOneRequest {
  state: Json
  questions: Record<string, { type: "noul"|"choice"|"score"; instructions?: string; criteria?: Json }>
  model?: string
}
export interface SystemOneAnswer {
  type: string
  noul?: number
  choice?: string
  score?: number
  confidence?: number | null
  probabilities?: Record<string, number>
  legend?: Record<string, string>
}
export interface SystemOneResult {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage?: { input_tokens: number | null; output_tokens: number | null }
}

/** The backend seam. v1 = Jev; an LLM backend must satisfy the same interface. */
export interface Judge {
  readonly modelId: string
  systemOne(req: SystemOneRequest, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SystemOneResult>
}

/** Jev `Judge`: dependency-free `fetch` client (NOT the SDK — see the finding above). */
export function createJevJudge(opts: {
  apiKey: string
  baseURL?: string       // default "https://opencode.ai/inference/systemone"
  model?: string         // default "jev-1.13-free"
  timeoutMs?: number     // default 10000
  fetch?: typeof fetch   // injectable for tests
}): Judge

export const DECIDE_TOOL_NAME = "decide"
export const DECIDE_NAMESPACE = "typesafe"

/** JSON Schema for the plugin tool's `input` (what the model writes). */
export const DECIDE_INPUT_SCHEMA: Record<string, unknown>
/** JSON Schema for the plugin tool's `output` (what Code Mode receives). */
export const DECIDE_OUTPUT_SCHEMA: Record<string, unknown>

/** The plugin tool definition, ready for `editor.add(...)`. */
export interface DecidePluginTool {
  name: typeof DECIDE_TOOL_NAME
  description: string
  input: Record<string, unknown>
  output: Record<string, unknown>
  options: { namespace: typeof DECIDE_NAMESPACE; codemode: true; pinned: true }
  execute(input: unknown, context?: unknown): Promise<{ output: DecideVerdict | DecideVerdict[]; content: string }>
}
export function createDecideTool(deps: {
  judge: Judge
  storage: StoragePort
  log?: (entry: Json) => void | Promise<void>
  now?: () => number          // default Date.now
  hash?: (input: string) => string   // default sha256 hex
}): DecidePluginTool

/** Same engine, Code Mode shaped, for the harness (no plugin host needed). */
export function createDecideRuntime(deps: /* same as above */): {
  call(call: DecideCall): Promise<DecideVerdict | DecideVerdict[]>
  tool: DecidePluginTool
}
```

`src/index.ts` (owned by the orchestrator) imports only `createDecideTool`, `DECIDE_*`,
`createDecideRuntime`, `createJevJudge`, and the two types `Judge`/`StoragePort`.

**Input schema shape** (`DECIDE_INPUT_SCHEMA`, `additionalProperties: false`):

```jsonc
{
  "type": "object",
  "properties": {
    "state":       { "description": "Text or JSON to judge. Keep it self-contained." },
    "questions":   { "oneOf": [ <Question>, { "type": "array", "items": <Question>, "minItems": 1 } ] },
    "escalateBelow": { "type": "number", "description": "..." },
    "model":       { "type": "string" },
    "cache":       { "type": "boolean", "default": true },
    "timeoutMs":   { "type": "number" }
  },
  "required": ["state", "questions"],
  "additionalProperties": false
}
// <Question> = { "type":"object", "required":["mode","id"],
//   "properties":{ "mode":{"enum":["noul","choice","score"]}, "id":{"type":"string"},
//                  "criterion":{"type":"string"}, "criteria":{...}, "options":{...},
//                  "levels":{"type":"array","items":{"type":"string"},"minItems":2},
//                  "escalateBelow":{"type":"number"} },
//   "additionalProperties": false }
```

**Output schema** (`DECIDE_OUTPUT_SCHEMA`): `oneOf` of the single-verdict object and an array of
them; verdict properties as in `DecideVerdict`, `required: [id, mode, value, confidence, modelId,
latencyMs, cached, escalate]`.

**Definition of done (A):** `bun test` green for `src/decide/**`; unit tests cover
(a) batch → one request, one result per question, order preserved;
(b) single question → single object (not an array);
(c) confidence math for all three modes (incl. `n=1` choice and missing score confidence);
(d) escalation with/without thresholds, per-question override, and low-confidence reason;
(e) cache hit path (`cached: true`, no second judge call) and `cache:false` bypass;
(f) API error → throws, no verdict;
(g) decision log entry shape, emitted once per request;
(h) schemas: `DECIDE_INPUT_SCHEMA`/`DECIDE_OUTPUT_SCHEMA` validate the shapes above (assert with
your own JSON Schema checker or by structural assertions — no new dependency without asking).
The `Judge` is always injected in tests; **no network in tests**.

---

## 2. Feature B — `src/builtins.ts` + `probe/**` (owner: worker B)

Built-ins ship `options: { codemode: false }`; the plugin flips them so they land in the sandbox.

```ts
export const BUILTIN_FILE_SHELL_IDS = ["read", "grep", "glob", "shell", "edit", "write"] as const
/** Never flip these: control-plane built-ins. */
export const NEVER_FLIP_IDS = ["question", "task", "skill", "todo", "plan", "lsp", "execute"] as const

export interface ToolEditorLike {
  list(): readonly { id: string; options?: { codemode?: boolean } | null }[]
  update(id: string, fn: (tool: { options?: Record<string, unknown> | null }) => void): void
}

export interface FlipReport {
  flipped: string[]
  already: string[]                       // already codemode: true
  skipped: { id: string; reason: string }[]
}

export function enableBuiltinsForCodeMode(
  editor: ToolEditorLike,
  opts?: { ids?: readonly string[]; enabled?: boolean },
): FlipReport
```

- Default `enabled: false` — the function is a **no-op returning `{flipped:[],already:[],skipped:[]}`**
  unless `enabled === true`. The caller (`src/index.ts`) passes `config.builtinsCodemode`.
- Requested ids that are absent from `editor.list()` are reported in `skipped` (never added by us).
- `NEVER_FLIP_IDS` are always `skipped` with reason `"control-plane"`, even if requested.
- Idempotent: a second call reports them under `already`, and does not re-`update`.
- `update` must preserve `name`/`namespace` — only touch `options.codemode` (merge into a copy).
- Never call `editor.remove`, never add tools.

`probe/live-builtins.ts` — a **manual**, documented live probe (`bun run probe`), not run in CI:
step-by-step, it must print (1) the pre-flip catalog state of the six built-ins (via
`ctx.tool.list()` inside a real `setup`), (2) the post-flip catalog, (3) whether each id still
appears on the agent's *direct* tool list (the exclusivity caveat), (4) the effective Code Mode
path of `decide` (`tools.decide` vs `tools.typesafe.decide`), (5) whether a nested `read` call
from a sandbox script still trips the leaf permission. It must be usable by a human with a
temporary `~/.config/opencode/plugins/` shim, and must say exactly what to paste and what to
look for. It must **refuse to run** (exit non-zero, explanatory message) if the host did not
load this plugin, rather than silently "passing".

**Definition of done (B):** unit tests with a fake editor covering flip / already / missing /
control-plane / idempotence / `enabled:false` no-op / `options` merge preserving other keys;
`probe/live-builtins.ts` typechecks, is documented in `README.md`'s "live probes" section
(**you own that section only** — see §5) and exits non-zero with a clear message when unloaded.

---

## 3. Feature C — `src/config.ts` + `src/hint.ts` (owner: worker C)

```ts
export interface DecideConfig {
  apiKey: string | undefined
  apiKeySource: "env" | "env-file" | "auth-json" | "options" | "none"
  baseURL: string                 // default "https://opencode.ai/inference/systemone"
  model: string                   // default "jev-1.13-free"
  builtinsCodemode: boolean       // default false
  builtinIds: string[]            // default [...BUILTIN_FILE_SHELL_IDS]  (import from ../builtins)
  envFile: string | undefined     // the .env actually read, if any
  hintEnabled: boolean            // default true
}

export function parseEnvFile(text: string): Record<string, string>
export function loadConfig(input?: {
  env?: Record<string, string | undefined>   // default process.env
  directory?: string                          // project dir, for <directory>/.env
  configDir?: string                          // default ~/.config/opencode
  authJsonPath?: string                       // default <configDir>/../.local/share/opencode/auth.json
}): DecideConfig
```

Key resolution order (first hit wins, and `apiKeySource` says which):
1. `input.overrides.apiKey` (only when the caller passes one — internal, used by `src/index.ts`).
2. `OPENCODE_API_KEY`, then `TYPESAFE_API_KEY`, in `env`.
3. The env file: `OPENCODE_DECIDE_ENV_FILE` (env var) → `<directory>/.env` → `<configDir>/.env`.
   Format: `KEY=VALUE` lines, `#` comments, optional single/double quotes, blank lines ignored.
4. `auth.json` → `.opencode.key` (dev convenience; disabled when `OPENCODE_DECIDE_ALLOW_AUTH_JSON=0`).
   Never log or return the key anywhere but `apiKey`.

Other keys: `OPENCODE_DECIDE_BASE_URL`, `OPENCODE_DECIDE_MODEL`, `OPENCODE_DECIDE_BUILTINS_CODEMODE`
(`1`/`true`/`yes`, case-insensitive), `OPENCODE_DECIDE_BUILTIN_IDS` (comma list),
`OPENCODE_DECIDE_HINT` (`0`/`false` disables), `OPENCODE_CONFIG_DIR`.
`loadConfig` must be **pure/testable**: no `process.exit`, no side effects beyond reads, and it must
never throw on a missing/unreadable auth.json (return `apiKeySource: "none"`).

`src/hint.ts`:

```ts
export function decideHint(config?: Pick<DecideConfig, "model">): string
```

The hint is injected via `ctx.session.hook("context", …)`. It must be **short** (aim ≤ 25 lines) and
must cover, in this order: that the tool lives in Code Mode and is called as
`tools.typesafe.decide(...)` with the fallback "if that path is missing, `search("decide")`";
the one-question and batch call shapes; the verdict fields; and the ≈3-line escalation handler from
the plan (`if (d.escalate) { console.log(...); break }`) with `d.reason`, the last tool output and a
`done` ledger. Every identifier it names must match §1 exactly (a test asserts that).

**Definition of done (C):** `bun test` green for `src/config.test.ts` (env precedence incl.
env-file and auth-json fallback, missing auth.json, boolean parsing, quoted values, `#` comments)
and `src/hint.test.ts` (mentions `tools.typesafe.decide`, `mode`, `id`, `escalate`, `reason`,
`confidence`, `value`, `probabilities`, `p`; stays under the line cap; is deterministic given the
same config). No network. Never read the real `~/.local/share/opencode/auth.json` in tests — use
fixtures.

---

## 4. Harness — `harness/**` (owners: D1 runner, D2 tasks/drivers)

The shared types file **`harness/types.ts` is owned by the orchestrator and frozen**
(see the file). Extra shared files: `harness/types.ts` only. Everything else is split:

- **D1 owns**: `harness/run.ts`, `harness/runner/**`, `harness/metrics/**`, `harness/report.ts`,
  `harness/pricing.ts`, `harness/sandbox/**` (the Code Mode tool tree + `decide` wiring),
  `harness/README.md`.
- **D2 owns**: `harness/tasks/**`, `harness/fixtures/**`, `harness/drivers/**`.

Two more frozen entry points (D2 owns the files, D1 imports them):

```ts
// harness/tasks/index.ts
export const TASKS: readonly TaskDef[]
export function getTask(id: string): TaskDef | undefined

// harness/drivers/index.ts
export function createMockDriver(opts?: {
  seed?: number
  /** Optional per-task overrides of the canned Code Mode program. */
  programs?: Record<string, { A?: string; B?: string; C?: string }>
  /** Synthetic token accounting model; clearly labelled as such in the report. */
  usageModel?: "small" | "cached-heavy"
}): ModelDriver
export function createOpenCodeCliDriver(opts?: {
  model?: string
  agent?: string
  binary?: string
}): ModelDriver
/** Offline Judge: answers keyed by question id; call log inspectable. */
export function createFakeJudge(script: Record<string, {
  noul?: number; choice?: string; score?: number; confidence?: number
}>): import("../../src/decide/index.ts").Judge
```

The three arms (plan §Measurement harness):

- **A — direct loop.** `ModelDriver.complete()` in a loop; each returned `toolCalls[]` is executed
  by `ToolBox` and appended to the transcript; stop on no tool calls or `maxTurns`.
- **B — script, no `decide`.** One model call producing a Code Mode program; executed by
  `CodeMode.make({ tools }).execute(code)` over the *same* `ToolBox`.
- **C — script + `decide`.** Same, with `tools.typesafe.decide` added (real `Judge` when a key is
  present, otherwise the D2 `fakeJudge`), and the task's `scriptPrompt` demanding the
  `escalate`/`break` handler.

Both script arms register the decide tool as namespace `typesafe`, so the script path is
`tools.typesafe.decide`. D1's sandbox must also expose `search`-equivalent discoverability only if
trivial (not required).

Reference implementation of the Jev `Judge` for offline runs: D2 exports
`createFakeJudge(script: Record<string, { noul?: number; choice?: string; score?: number;
confidence?: number }>)`, whose answers are keyed by question id and whose call log is inspectable.
`harness/types.ts` declares `harness/driver.ts`-level contracts; do not change them.

**Definition of done (D1):** `bun run harness/run.ts --tasks <id> --arms A,B,C --runs 1 --driver mock`
runs offline, writes `out/<stamp>/report.json` + `report.md`, and `bun test harness/runner` passes
(arm wiring, metric plumbing, report shape). The `opencode` CLI driver must be implemented but its
execution is only documented, not required, in this run.
**Definition of done (D2):** 4–5 task fixtures exist (`bun run harness/run.ts --list` lists them)
with `long-loop` tasks represented, each with a working `verify()`; the `mock` driver and
`fakeJudge` are deterministic (same seed ⇒ same transcript) and covered by `bun test harness`
tests you own.

---

## 5. Shared files (orchestrator-owned — do not edit)

`package.json`, `package-lock.json`/`bun.lock`, `tsconfig.json`, `.gitignore`, `docs/CONTRACTS.md`,
`harness/types.ts`, `src/index.ts`, `src/globals.d.ts`, `README.md`, `.env.example`.

Each worker may add its own tests next to its sources (`src/decide/decide.test.ts`,
`src/config.test.ts`, `harness/tasks/...test.ts`, …). If a worker needs a new dependency, or needs
to change a shared file, it **stops and reports** instead.

### Worker B's one license to edit `README.md`

Worker B appends a `## Live probes` section to `README.md`. To avoid a write conflict, worker B
must **write that section to `docs/live-probes.md`** instead and report the file; the orchestrator
moves it into `README.md`. No worker edits `README.md` directly.
