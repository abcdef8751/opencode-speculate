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
| `~/.config/opencode/.env` | **Created** — `OPENCODE_DECIDE_BUILTINS_CODEMODE=0` (built-ins **not** flipped globally) and `OPENCODE_API_KEY=` (empty ⇒ resolution falls through to `~/.local/share/opencode/auth.json`; **no key is stored in any file we changed**). The contents are entirely ours; if an `.env` existed here before, it was overwritten. | `rm` it (or delete both keys), then `opencode reload` |
| `~/.config/opencode/AGENTS.md` | **Appended** one paragraph — the trailing "`decide()` — TypeSafe/Jev fuzzy judgement…" block. | delete that paragraph |
| `/home/rp/opencode-speculate/.env` | **Created**, gitignored (`.gitignore` line 4) — `OPENCODE_DECIDE_BUILTINS_CODEMODE=1`, flipping the six built-ins **only** for sessions rooted in this repo. | set to `0` or `rm` it, then `opencode reload` |

Why the flip is repo-scoped, not global (measured live 2026-10-16, not assumed): `codemode: true`
**moves** a built-in off the agent's direct tool list into the Code Mode sandbox — it does not
duplicate it (either/or). Enabling it globally would remove direct `read`/`grep`/`glob`/`shell`/`edit`/`write`
from every session on the machine.

Consequence for agents **in this repo**: there are no direct file/shell tools — reach them inside
`execute` via `tools.read({ path })`, `tools.shell({ command })`, `tools.edit({ path, oldString, newString })`,
`tools.write({ path, content })`, `tools.grep({ pattern, path })`, `tools.glob({ pattern, path })`.

Notes: a temporary probe shim (`plugins/codemode-builtins-probe.ts`) was used during live probing and
is **already removed** — nothing to reverse. Pre-existing and unrelated: `plugins/ensemble.ts`,
`plugins/opencode-ensemble/`. Use `opencode reload` rather than `opencode service restart` — a restart
would kill the session doing the work.
