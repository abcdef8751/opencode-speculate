# Code Mode `decide()` + measurement harness

Implementation of `~/.opencode/plan/codemode-decide-v1.md` (steps 1–4): a state-centric
**`decide()`** judge exposed as an OpenCode V2 plugin tool, plus the headless 3-arm harness that
measures whether collapsing a tool-call loop into one Code Mode script actually reduces main-model
cache re-reads at equal-or-better correctness.

Nothing here is registered in the live host yet. `src/index.ts` (the plugin entry) is wired at
integration time; loading it globally is a separate, deliberate step (`docs/live-probes.md`).

## Layout

| Path | What | Contract |
| --- | --- | --- |
| `src/decide/**` | `decide` engine, Jev `Judge` seam, cache, decision log, tool + schemas | `docs/CONTRACTS.md` §1 |
| `src/builtins.ts` | flips `options.codemode` on file/shell built-ins (default OFF) | §2 |
| `probe/live-builtins.ts` | manual live probe: exclusivity caveat, leaf permissions, `decide` path | §2 |
| `src/config.ts` | env / `.env` / auth.json resolution, feature flags | §3 |
| `src/hint.ts` | the session-context hint teaching the ≈3-line escalation handler | §3 |
| `harness/**` | 3 arms × tasks × runs, metrics, report | §4 |
| `harness/types.ts` | frozen cross-boundary types | — |

## Run

```sh
bun install
bun test
bun run typecheck
bun run harness --list                       # list tasks
bun run harness --tasks <id> --arms A,B,C --runs 1 --driver mock
```

## Backend

Jev is reached through the OpenCode Console systemone endpoint
(`https://opencode.ai/inference/systemone/v1/systemone`, model `jev-1.13-free`) via
`@typesafe-ai/sdk` pointed at that base URL. The key is resolved from `OPENCODE_API_KEY` (env or
`.env`) — see `.env.example`. Keys are never logged.

## Key findings that this repo builds on

- Plugin tools land in Code Mode, not the native tool list — the vendored ensemble plugin hit this
  live (`~/.config/opencode/plugins/opencode-ensemble/src/v2-setup.ts`).
- Built-ins ship `options: { codemode: false }`, so they are *not* in the sandbox by default;
  flipping the option is a supported plugin transform and leaves leaf permissions intact.
- `tools.<anything>` is a callable stub: `typeof` lies, only calling reveals absence.
- The interpreter has no `import`/`process`; `throw`/`try`/`catch` work, and `Error` carries
  `message`. Payloads must be JSON in the message.

## Backend findings (measured 2026-10-16, this machine)

- The OpenCode Console systemone endpoint is a faithful Jev/TypeSafe JSON API: verified live with
  `noul`/`choice`/`score` in one batch, states from 1 B to 44 KB, HTTP 200, response
  `{model, answers, usage}`. `jev-1.13-free` costs nothing.
- **`@typesafe-ai/sdk@0.7.0` cannot be used from the plugin path.** Under Bun it throws
  `TypeError: Body already used` on larger request states (its `bufferResponse` drains
  `response.clone()` and then re-reads the same response); the same call works under Node 26. It
  also sends zstd by default, which this endpoint rejects with `400`. See
  `docs/CONTRACTS.md` → the `@typesafe-ai/sdk` finding. `decide` therefore uses a small
  dependency-free `fetch` client.
- Cloudflare on `opencode.ai` bans unknown User-Agents (`Error 1010`) — always send a normal UA.

