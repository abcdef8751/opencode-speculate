## Live probes

Manual, human-run probes for the questions that cannot be answered offline. **Never run these in
CI**, and never wire them into `bun test`: they require a live OpenCode host, a restart, and a
human watching the TUI. They make **no network calls and never invoke a model** — the one step that
touches a model is a human typing a message so the host issues a request.

### `probe/live-builtins.ts` — built-ins inside Code Mode

Feature B flips `options.codemode` on the six file/shell built-ins (`read`, `grep`, `glob`,
`shell`, `edit`, `write`) through the supported `ctx.tool.transform` seam. Two things are still
unknown and this probe settles them:

1. **Surface exclusivity.** Does `codemode: true` *remove* a tool from the agent's direct/native
   tool list (either/or), or do the native and sandbox copies coexist?
2. **Leaf permissions.** Does a nested `read` call made from inside a Code Mode script still run
   through the tool pipeline (so `access.authorizeRead` / the approval prompt fires)?

It also checks three things we want to keep honest:

3. the effective Code Mode path of `decide` (`tools.decide` vs `tools.typesafe.decide`);
4. the pre/post catalog state of the six built-ins around the flip;
5. that the flip touched only `options.codemode` and preserved every other option key.

`probe/live-builtins.ts` has two faces:

- **as a plugin**, it records what the host actually did (catalog before/after the flip, the
  model-facing direct tool list per request, every `execute.before`/`execute.after`);
- **as a CLI** (`bun run probe`), it reads that record and prints a report. It **refuses to run**
  (non-zero exit + explanation) unless the host actually loaded the plugin, so an unloaded probe
  can never be mistaken for a pass.

#### Prerequisites

- A live OpenCode V2 host (`opencode` 2.0.x) on this machine.
- The record path defaults to `/tmp/opencode/opencode-decide-builtins-probe.json`
  (override with `OPENCODE_DECIDE_PROBE_FILE`).
- To answer **(3)** you also need the main plugin loaded (the `decide` tool). Load it the same way
  you load any plugin for a run; if it is absent, section (3) says so instead of guessing.

#### 1. Paste the discovery shim

OpenCode V2 discovers plugins in `~/.config/opencode/plugins/`. Create one file that re-exports
this probe's default export — exactly like the vendored `ensemble.ts` shim. Replace the path with
the absolute path to this checkout (the probe prints the exact line for your machine when you run
it):

```sh
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/codemode-builtins-probe.ts <<'SHIM'
export { default } from "/home/rp/opencode-speculate/probe/live-builtins.ts"
SHIM
```

> Do **not** add a `plugins` key to `~/.config/opencode/opencode.json` — that config is V1-shaped
> and ignored by V2. Discovery of `~/.config/opencode/plugins/` is what loads it.

#### 2. Restart the host

Plugin changes are only picked up on restart:

```sh
opencode service restart
```

The host logs a line like
`[codemode-builtins-probe] loaded in opencode 2.0.30 (…)` when the plugin is live.

#### 3. Run the CLI

```sh
bun run probe          # == bun run probe/live-builtins.ts
```

Before step 2 this **exits non-zero** with "the host did not load this plugin". After step 2 it
prints the report.

Exit codes: `0` ok · `1` plugin not loaded · `2` record stale (older than 6h; pass `--allow-stale`
to inspect anyway) · `3` loaded but no tool transform observed. Also `bun run probe -- --json` for
the raw record.

#### 4. Human steps (do these, then re-run `bun run probe`)

- **Direct tool list (question 1).** Any single message in the TUI makes the host issue a model
  request, and the probe's `session.context` hook records the tool map the model was offered.
  Send e.g. `say hi`. *This is the only step that involves a model; the probe itself never calls
  one.*
- **Nested leaf permission (question 2).** Make the file and run a tiny Code Mode script in an
  existing session:

  ```sh
  echo probe > /tmp/opencode/probe-read.txt
  ```

  ```js
  const r = await tools.read({ filePath: "/tmp/opencode/probe-read.txt" })
  return r
  ```

  Watch whether the agent asks for read/shell approval. Then re-run `bun run probe`.

#### What the report means

| # | Question | How it is answered |
| --- | --- | --- |
| 1 | pre-flip catalog of the six | **Automated** — read inside the host's tool transform before the flip |
| 2 | post-flip catalog + merge safety | **Automated** — read after the flip, plus `ctx.tool.list()` |
| 3 | direct-list exclusivity | **Automated capture, human-triggered** request; cross-check the TUI tool list by eye |
| 4 | effective `decide` path | **Automated** — `tools.typesafe.decide` when namespaced, else `tools.decide` |
| 5 | nested `read` still in the pipeline | **Automated capture** of `execute.before/after`; the approval **prompt** is human-observed |

Interpretation pointers printed by the report:

- Section (3): if **none** of the six appear on the direct list after the flip, `codemode: true`
  **removes** them from the native list (either/or); if some still appear, the surfaces
  **coexist**.
- Section (4): `typeof tools.X.decide` lies — only calling reveals absence. Trust the printed path.
- Section (5): a `read` appearing in `execute.before`/`execute.after` means the nested sandbox call
  still runs through the captured tool, so leaf permission checks still fire; whether the prompt is
  shown is watched in the TUI.

#### 5. Clean up

```sh
rm ~/.config/opencode/plugins/codemode-builtins-probe.ts
opencode service restart
```

### Safety notes

- Both shims run with the host's full permissions; nothing here pushes, merges, or resets.
- The probe never prints secrets: the plugin options are recorded as **key names only**.
- The probe writes only to its record file (`/tmp/opencode/…` by default).
