# Measurement harness (feature D1)

A runnable, reproducible, headless measurement rig for the **Code Mode cache-read hypothesis**:
collapsing a turn-by-turn tool loop into one Code Mode script should cut the main model's
cache-read tokens at equal-or-better correctness, and the `decide` escalation lever should keep
quality up without escalating constantly.

Contract: `docs/CONTRACTS.md` §4. Frozen types: `harness/types.ts`. Task/driver modules are owned
by worker D2 (`harness/tasks/**`, `harness/fixtures/**`, `harness/drivers/**`); this directory owns
`harness/run.ts`, `harness/runner/**`, `harness/sandbox/**`, `harness/metrics/**`,
`harness/pricing.ts`, `harness/report.ts`, `harness/README.md`.

## Run

```sh
bun run harness --list                                    # id, kind, title per task
bun run harness --tasks <id> --arms A,B,C --runs 1 --driver mock
```

Flags: `--tasks <id[,id...]>`, `--arms <A,B,C>`, `--runs <n>`, `--driver mock|opencode`,
`--max-turns <n>` (arm A budget, default 12), `--seed <n>`, `--out <dir>` (default `out`),
`--keep-scratch`, `--help`. `--driver mock` is the default and is **fully offline**.

Output: `out/<stamp>/report.json` (the frozen `RunReport`) and `out/<stamp>/report.md`
(per-arm summary table, gate verdict, per-run detail, harness notes). The CLI also prints the
summary table and the gate.

Tests: `bun test harness` (unit tests for the sandbox, arms, metrics, report, shim, CLI parsing).
`bun run typecheck` covers everything.

## The three arms

| Arm | What it does | Turns counted |
| --- | --- | --- |
| **A** — direct loop | `ModelDriver.complete()` in a loop; every returned `toolCalls[]` is executed via `ToolBox.call()` and appended as a `tool` message; stops on a turn with no tool calls, or at `maxTurns`. | one per `complete()` |
| **B** — script | **one** model call producing one Code Mode program, executed by `CodeMode.make({tools}).execute(code)` over the same `ToolBox`. | 1 |
| **C** — script + decide | same as B, plus `tools.typesafe.decide` registered via `createDecideRuntime({ judge, storage, log })` (§1), with the task's `escalationPrompt` appended. Real `Judge` when a key is configured **and the driver is not `mock`**; otherwise the offline fake judge. | 1 |

Each (task, run, arm) gets its own **fresh scratch directory** — a copy of `TaskDef.fixture`, then
`TaskDef.setup?.(dir)`. Scratch lives under `/tmp/opencode/harness-runs/<stamp>/<task>/run-<n>/<arm>`
and is removed at the end unless `--keep-scratch` is passed. The fixture source is never mutated.

## Driver conventions (contract friction — read this)

`ModelDriver.complete(req)` is frozen and carries **no arm identifier**, so arm selection is
communicated three ways; a driver must handle at least the marker:

1. the first system message begins with `harness:arm=<A|B|C>;task=<id>;run=<n>`
   (`armSystemMessage()`; parse with `parseArmMarker()`);
2. arm A receives the real `ToolBox.descriptors`; arms B/C receive a single synthetic `execute`
   tool (`EXECUTE_TOOL`);
3. arms B/C expect the program in `ModelResponse.text` (fenced or bare) **or** in an `execute` tool
   call with `{ code }`; `extractScript()` accepts both.

This is the only place the harness had to invent a convention, because the frozen `ModelDriver`
type cannot express it. It is documented here and surfaced in the report's harness notes.

## Module resolution and the offline fallback

`harness/runner/sources.ts` loads the frozen entry points and **prefers the real modules**:

- `harness/tasks/index.ts` → `TASKS`, `getTask`
- `harness/drivers/index.ts` → `createMockDriver`, `createOpenCodeCliDriver`, `createFakeJudge`
- `src/decide/index.ts` → `createDecideRuntime` (§1), plus `createJevJudge` when present

D1's worktree is cut from the scaffold commit, so those files do not exist here. When a module is
**absent** (module-not-found only — any other load error is rethrown), the harness falls back to the
labelled dev shim in `harness/runner/fallback/**`:

- `fallback/scenario.ts` — three tiny offline tasks + fixtures (a typo fix, a TODO count, a long-loop
  uppercase job) with canned arm-A plans, canned B/C programs and fake-judge answers;
- `fallback/drivers.ts` — deterministic mock driver, `createFakeJudge`, and a real
  `opencode run` CLI driver;
- `fallback/decide-shim.ts` — a **dev shim** implementing the §1 seam only well enough for arm C to
  run offline. It is not the contract implementation and must not be treated as one.

Every fallback use is reported (`warning:` on stderr, a `modules: tasks=… drivers=… decide=…` note
in `report.md`). Once D2/A land, the real modules are used and the shim goes dormant — this was
verified by overlaying `harness/**` on `main` (which already has `src/decide/index.ts`) and running
`bun run harness --tasks … --arms A,B,C --driver mock`: the report's harness note read
`modules: tasks=fallback drivers=fallback decide=module`, arm C used the real engine, and
`bun test harness` + `bun run typecheck` stayed green. Because the
fallback judge only knows the fallback question ids, arm C escalates ("no usable answer") for real
D2 tasks unless the task carries a duck-typed `judgeAnswers` map or `judgeScript` is supplied to
`runHarness()`.

## Metrics

`ArmResult` (frozen) is filled as follows:

| Field | Meaning |
| --- | --- |
| `turns` | `complete()` calls (A: loop turns; B/C: 1, or 0 on a driver error) |
| `usage` | summed `TokenUsage`; `costUsd` comes from the driver, else from `pricing.ts` when the model is known |
| `wallMs` | wall clock around the arm (injectable clock for tests) |
| `toolCalls` | every tool name the arm ran, in order (for C this includes `typesafe.decide`) |
| `toolFailures` | tool calls that failed: arm A counts thrown `ToolBox.call()`s; B/C count Code Mode hook results with `status: "failure"` |
| `correctness` | `TaskDef.verify(scratchDir)`; a throwing `verify` becomes `passed: false` with the message |
| `transcript` | the Code Mode program (B/C) or the final assistant text (A) |
| `logs` | Code Mode `console.log` output |
| `decideCalls` / `decideLatencyMs` | §1 decision-log entries (one per judge request) and their summed `latencyMs` |
| `escalated` / `escalations` | `escalations` = verdicts with `escalate: true`; `escalated` = `escalations > 0` |
| `scriptFailures` | one per failed Code Mode execution, plus parse-shaped warnings (see `calculateScriptFailures`) |
| `ok` | the arm completed without a harness-level error; for B/C it is the Code Mode execution result, so a failed script sets `ok: false` (correctness is separate) |
| `notes` | script return values (truncated), warnings, stop reasons, tool-failure text |

`harness/metrics/aggregate.ts` builds `ArmSummary` (means per arm, `escalationRate` and
`scriptFailureRate` as rates over runs) and evaluates `GateVerdict`:

- `cacheReadDownVsA` — arm C's mean cache-read tokens < arm A's (the hypothesis);
- `cacheReadDownVsB` — C < B (informational: does `decide` cost cache reads on top of the script?);
- `correctnessEqualOrBetter` — C's pass rate ≥ A's **and** ≥ B's;
- `escalationLow` — C's escalation rate ≤ 0.25 (override via `GateOptions.maxEscalationRate`);
- `pass` — `cacheReadDownVsA && correctnessEqualOrBetter && escalationLow` and C produced runs.

## The sandbox (`harness/sandbox/**`)

`createToolBox({ dir, names })` exposes the six built-ins the `builtins-flip` work toggles —
`read`, `grep`, `glob`, `shell`, `edit`, `write` — confined to `dir`. `names` honours
`TaskDef.tools`. The inputs/outputs follow the **ratified shapes** in `docs/CONTRACTS.md` §4:

| tool | input | output |
| --- | --- | --- |
| `read` | `{ path }` (optional `offset`, `limit`) | file text (string; truncated at 200 KB) |
| `grep` | `{ pattern, path? }` (optional `include`, `literal`, `ignoreCase`, `maxResults`) | `{ matches: [{ path, line, text }], files, count }` |
| `glob` | `{ pattern }` | `{ files, paths, count }` |
| `write` | `{ path, content }` | `{ ok, path, bytes, text }` (confirmation text) |
| `edit` | `{ path, find, replace }` (optional `replaceAll`) | `{ ok, path, replacements, text }` |
| `shell` | `{ command }` (optional `args`, `timeoutMs`) | `{ ok, stdout, stderr, exitCode, text, command }` |

`edit` also accepts `oldString`/`newString` as aliases. `shell` returns a non-zero `exitCode`
instead of throwing (the ratified shape carries it); it throws only when the command cannot be run
at all (ENOENT/EACCES), times out, or is killed by a signal.

The toolbox is exposed in two shapes:

- `descriptors` / `call(name, input)` for arm A;
- the Code Mode tool tree (via `executeScript`) for arms B/C, with `typesafe.decide` mounted from
  the §1 plugin tool when a decide runtime is supplied.

Search-equivalent discoverability needs no extra work: the CodeMode runtime provides the `search`
global itself, and it reports the sandbox tree (`search({ query: "decide" })` →
`tools.typesafe.decide`), asserted by a sandbox test.

Implementation notes:

- built on `node:fs/promises` + `node:child_process` `execFile` with `cwd: dir`, an explicit
  timeout and `shell: false` — **never** `shell: true`, never a shell-interpolated command string;
- every path goes through `path.resolve` + a prefix check, and the deepest existing ancestor is
  also `realpath`-checked (symlink escape);
- `shell` takes `{ command }` (tokenised with quote support) plus optional `args`. `tokenizeCommand`
  handles quotes only — **no** pipes, redirection, globbing or variable expansion, because there is
  no shell;
- the Code Mode interpreter exposes no network (`fetch`/`process` are `undefined` in the sandbox;
  asserted by a test). The harness never injects a network global;
- **confinement is honest but not a security boundary.** It prevents accidental path escapes and
  symlink tricks, but there is no seccomp, mount namespace, CPU limit or privilege drop, and TOCTOU
  races are possible. Do not run untrusted programs through it.

## Drivers

**`--driver mock`** uses `createMockDriver()`: deterministic (`seed`), offline, and its token
accounting is **synthetic** (`usageModel: "small" | "cached-heavy"`). Reports that use it are
labelled "Synthetic usage" in `report.md` and on stdout — treat mock numbers as plumbing evidence,
never as measurement.

**`--driver opencode`** uses `createOpenCodeCliDriver()`:

```
opencode run --format json --standalone [--model <provider/model>] [--agent <agent>] <prompt>
```

Assumptions and limitations (not exercised in this run — it needs a live model):

- one `complete()` == one `opencode run` invocation, so `turns` counts invocations, not model turns;
- the child runs with the scratch directory as `cwd` and uses the **CLI's own tools** — the harness
  `ToolBox` cannot be injected into the CLI, so arm A is not turn-by-turn here and the three arms
  differ only in prompt;
- the transcript is rendered into one prompt, passed as a single positional argument;
- `--standalone` is used so the run does not attach to a background service;
- token usage is parsed tolerantly from JSON lines (`usage`/`tokens` keys in snake_case or
  camelCase; the last usage object wins). Unparsed output is reported as notes and usage zeros
  rather than failing the run;
- `process.env` is inherited so the CLI can resolve its own auth. Keys are never logged.

## Pricing

`harness/pricing.ts` maps a model id to per-1M input / cached-read / output prices and returns
`undefined` for anything unknown — **the harness never guesses a price**. An unknown model leaves
`usage.costUsd` unset and the report shows `n/a`. Cache-write tokens are billed at the input price
(the endpoint reports one input tariff). Add entries to `PRICES` only with a citeable source.

## Known contract friction (for the orchestrator)

1. **Arm selection** is not expressible in the frozen `ModelDriver` — see "Driver conventions".
2. **ToolBox shapes** are now ratified in §4 and implemented exactly (including `edit`'s
   `find`/`replace` and `shell`'s `exitCode`); `oldString`/`newString` remain accepted aliases.
3. **`ok` for arms B/C** means "the Code Mode program ran"; script-level failures are counted in
   `scriptFailures`. The frozen doc only says `ok` is "not the same as task correctness".
4. **`scriptFailures`** is defined here as one point per failed execution plus parse-shaped
   warnings; a single-call arm cannot observe a "model retry".
5. **`createFakeJudge` answers** for real D2 tasks are unknown to the harness; missing ids escalate
   loudly ("no usable answer") rather than being invented (see "Module resolution").
