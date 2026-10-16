/**
 * Feature B — flip `options.codemode` on OpenCode's file/shell built-ins so they
 * land inside the Code Mode sandbox.
 *
 * Contract: `docs/CONTRACTS.md` §2 (binding).
 *
 * Background (verified on this machine, V2 `2.0.30`): the built-ins ship
 * `options: { codemode: false }`, so they are not in the sandbox by default.
 * `ctx.tool.transform(cb)` is the supported plugin seam: the callback receives a
 * tool editor whose `update(id, fn)` mutates the registered tool in place. We
 * only ever touch `options.codemode` on a *copy* of the options object, leave
 * `name`/`namespace`/other option keys alone, and never add or remove tools.
 *
 * The transform is OFF by default (`enabled: false` is a strict no-op): the
 * caller (`src/index.ts`) passes `config.builtinsCodemode`.
 */

/** The file/shell built-ins we want inside Code Mode. */
export const BUILTIN_FILE_SHELL_IDS = ["read", "grep", "glob", "shell", "edit", "write"] as const

/**
 * Control-plane built-ins that must never be flipped into the sandbox: they
 * drive the agent loop / UI and moving them would change host behaviour.
 */
export const NEVER_FLIP_IDS = ["question", "task", "skill", "todo", "plan", "lsp", "execute"] as const

/**
 * Minimal structural subset of the V2 `ToolEditor` (`@opencode/plugin`), so this
 * module stays host-independent and unit-testable with a fake editor.
 */
export interface ToolEditorLike {
  list(): readonly { id: string; options?: { codemode?: boolean } | null }[]
  update(id: string, fn: (tool: { options?: Record<string, unknown> | null }) => void): void
}

/** What the transform did, per id. */
export interface FlipReport {
  /** Requested, present, `codemode !== true` → we set it to `true`. */
  flipped: string[]
  /** Requested, present, already `codemode: true` → nothing to do. */
  already: string[]
  /** Requested but not flipped: control-plane or absent. */
  skipped: { id: string; reason: string }[]
}

/** Reason reported for a requested `NEVER_FLIP_IDS` entry. */
const REASON_CONTROL_PLANE = "control-plane"
/** Reason reported for a requested id that is absent from the catalog. */
const REASON_NOT_FOUND = "not-found"

const NEVER_FLIP: ReadonlySet<string> = new Set<string>(NEVER_FLIP_IDS)

/** Stable de-duplication that keeps first-seen order. */
function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Flip the requested built-ins into Code Mode.
 *
 * - `enabled: false` (the default) is a strict no-op: empty report, and the
 *   `editor` is not touched at all.
 * - `NEVER_FLIP_IDS` are always skipped with reason `"control-plane"`, even when
 *   requested and even when absent.
 * - Requested ids missing from the catalog are skipped (`"not-found"`); we never
 *   add tools.
 * - Idempotent: ids already `codemode: true` are reported under `already` and are
 *   not re-`update`d.
 * - `update` merges only `options.codemode` into a copy, preserving every other
 *   option key; `name`/`namespace` are untouched.
 * - Never calls `editor.remove`; never adds tools.
 */
export function enableBuiltinsForCodeMode(
  editor: ToolEditorLike,
  opts?: { ids?: readonly string[]; enabled?: boolean },
): FlipReport {
  if (opts?.enabled !== true) return { flipped: [], already: [], skipped: [] }

  const requested = unique(opts.ids ?? BUILTIN_FILE_SHELL_IDS)
  const report: FlipReport = { flipped: [], already: [], skipped: [] }

  const present = new Map<string, { id: string; options?: { codemode?: boolean } | null }>()
  for (const tool of editor.list()) present.set(tool.id, tool)

  for (const id of requested) {
    if (NEVER_FLIP.has(id)) {
      report.skipped.push({ id, reason: REASON_CONTROL_PLANE })
      continue
    }

    const tool = present.get(id)
    if (tool === undefined) {
      report.skipped.push({ id, reason: REASON_NOT_FOUND })
      continue
    }

    if (tool.options?.codemode === true) {
      report.already.push(id)
      continue
    }

    editor.update(id, (target) => {
      // Merge into a *copy*: preserve namespace, permission, pinned, and any
      // other option key the host set. Only `codemode` changes.
      target.options = { ...(target.options ?? {}), codemode: true }
    })
    report.flipped.push(id)
  }

  return report
}
