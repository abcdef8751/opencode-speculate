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
