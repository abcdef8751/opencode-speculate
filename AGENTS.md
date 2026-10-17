# Repo rules (all agents)

`docs/CONTRACTS.md` is the interface authority. Read the section for your feature before writing code.

- **Stay in your owned paths.** Never edit a shared file: `package.json`, `bun.lock`, `tsconfig.json`,
  `.gitignore`, `README.md`, `docs/CONTRACTS.md`, `harness/types.ts`, `src/index.ts`, `src/globals.d.ts`,
  `.env.example`. If you need one of them changed, stop and report it.
- **Code against the frozen contract.** Do not invent signatures, schemas, or env keys.
- Tests live next to your sources (`src/decide/*.test.ts`, `harness/**/*.test.ts`, …).
- `bun test` and `bun run typecheck` must pass for your paths. Do not add dependencies.
- **No network in tests.** Inject the `Judge`/`fetch`; never call the real Jev endpoint from a test.
- Commit small and often. Never `git push`, never `git merge`, never `git reset --hard`.
- No secrets in code or logs: the API key is read at runtime, never printed, never committed.
- The interpreter/plugin target is **OpenCode V2 `@opencode/plugin@2.0.30`**; ignore V1 shapes.

## Reference implementations on this machine

- Vendored plugin (V2 load/setup/hooks/tools): `~/.config/opencode/plugins/opencode-ensemble/src/v2-*.ts`
- Verified plugin typings: `node_modules/@opencode/plugin/dist/**`
- Code Mode runtime: `node_modules/@opencode/codemode/dist/**`

## Host config changed by this project (for reversal)

The `decide` plugin loads **globally**, so this work changed files **outside the repo**. None are in
git, and `~/.config/opencode/` is **not** a git repo — reversal is manual edits. Nothing else on the
host was touched (`opencode.json`, `cli.json`, `mcp/`, `plugin/`, `ensemble.*`, `agents/` are as
they were).

| Path | Change | To reverse |
| --- | --- | --- |
| `~/.config/opencode/plugins/codemode-decide.ts` | **Created** 2026-10-16 — discovery shim: `export { default } from "/home/rp/opencode-speculate/src/index.ts"`. V2 loads plugins only by discovery in this directory, so without the file `decide` does not exist at all. | `rm` it, then `opencode reload` |
| `~/.config/opencode/.env` | **Created**, then set to `OPENCODE_DECIDE_BUILTINS_CODEMODE=1` on 2026-10-16 (built-ins flipped **globally** — user's call). On 2026-10-17 the judge backend moved to Liquid AI `d1-ultra`, so `LIQUID_AI_API_KEY=<key>` was added here (same value as the repo `.env`; the old `OPENCODE_API_KEY=` line stays empty — the OpenCode Console key no longer works from a plugin, it 403s `FreeTierError`). `OPENCODE_DECIDE_MODEL` / `OPENCODE_DECIDE_BASE_URL` are not set: the code defaults to `d1-ultra` / `https://api.liquid.ai/decisions`. The contents are entirely ours; if an `.env` existed here before, it was overwritten. | `rm` it (or delete the keys), then `opencode reload` |
| `~/.config/opencode/AGENTS.md` | **Appended** one paragraph — the trailing "`decide()` — Liquid AI `d1-ultra` fuzzy judgement…" block. | delete that paragraph |
| `/home/rp/opencode-speculate/.env` | **Created**, gitignored (`.gitignore` line 4) — `OPENCODE_DECIDE_BUILTINS_CODEMODE=1` and (since 2026-10-17) `LIQUID_AI_API_KEY=<key>`, the Liquid `d1-ultra` key the plugin uses. Redundant since the global flag became 1; kept as an explicit pin and as the place to flip this project alone. While it exists the global `.env` is **not** read here (first existing file wins, no merge). | set to `0` or `rm` it to fall back to the global file, then `opencode reload` |

Why this is a real trade (measured live 2026-10-16, not assumed): `codemode: true` **moves** a built-in
off the agent's direct tool list into the Code Mode sandbox — it does not duplicate it (either/or). The
flip was repo-scoped at first for that reason; it is now **global at the user's request**, which means
no session on this machine has direct `read`/`grep`/`glob`/`shell`/`edit`/`write`.

Consequence for agents **on this host** (every session, since the flip is global): there are no direct
file/shell tools — reach them inside
`execute` via `tools.read({ path })`, `tools.shell({ command })`, `tools.edit({ path, oldString, newString })`,
`tools.write({ path, content })`, `tools.grep({ pattern, path })`, `tools.glob({ pattern, path })`.

Notes: a temporary probe shim (`plugins/codemode-builtins-probe.ts`) was used during live probing and
is **already removed** — nothing to reverse. Pre-existing and unrelated: `plugins/ensemble.ts`,
`plugins/opencode-ensemble/`. Use `opencode reload` rather than `opencode service restart` — a restart
would kill the session doing the work.

One caveat learned the hard way: run `opencode reload` from a plain terminal, **not** from inside a Code
Mode `execute` script. The reload tears down the session that is hosting the sandbox, so the running
script dies with `Tool.Error` mid-way (observed while landing this work). Commands that had already run
before the reload do take effect — the failure is the script, not the change — but it is impossible to
see that from the error, so treat any reload-inside-`execute` as an unknown partial state and re-check.

Corollary, from the same incident: never write that command in backticks inside a double-quoted shell
string in an `execute` script — backticks are command substitution, so the shell runs it. That is how
this very note's commit message came out as "do not run Configuration reloaded from inside a Code Mode
script": the reload executed while the message was being built.
