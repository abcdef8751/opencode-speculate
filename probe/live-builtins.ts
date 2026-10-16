#!/usr/bin/env bun
/**
 * MANUAL live probe for Feature B — built-ins inside Code Mode.
 *
 * This file has two faces:
 *
 *  1. As a **plugin**, loaded by a live OpenCode V2 host through the discovery
 *     shim in `~/.config/opencode/plugins/`. Its `setup(ctx)` records what the
 *     host actually did: the pre/post catalog around our `codemode` flip, the
 *     model-facing ("direct") tool list per request, and every `execute.before`
 *     / `execute.after` (which reveals whether a nested sandbox `read` still
 *     goes through the tool pipeline).
 *
 *  2. As a **CLI**, run by a human with `bun run probe` (`bun run probe/live-builtins.ts`).
 *     It reads the record the plugin wrote and prints a full report. It refuses
 *     to run — non-zero exit + explanation — unless the host actually loaded the
 *     plugin, so an unloaded probe can never look like a pass.
 *
 * The probe itself makes **no network calls and never invokes a model**. The one
 * human-triggered step that involves the model (typing any message so a request
 * fires and the `context` hook can observe the direct tool list) is spelled out
 * in the instructions and clearly marked HUMAN.
 *
 * Exit codes (CLI): 0 = ok, 1 = plugin not loaded, 2 = record stale,
 * 3 = loaded but no tool transform observed.
 *
 * See `docs/live-probes.md` for the shim to paste and the exact commands.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  BUILTIN_FILE_SHELL_IDS,
  NEVER_FLIP_IDS,
  enableBuiltinsForCodeMode,
  type FlipReport,
  type ToolEditorLike,
} from "../src/builtins.ts"

// ---------------------------------------------------------------------------
// Shared configuration
// ---------------------------------------------------------------------------

export const PROBE_PLUGIN_ID = "codemode-builtins-probe"

/** Record written by the loaded plugin and read by the CLI. */
export const PROBE_STATE_PATH =
  process.env.OPENCODE_DECIDE_PROBE_FILE ?? "/tmp/opencode/opencode-decide-builtins-probe.json"

/** CLI refuses a record older than this unless `--allow-stale` is passed. */
export const PROBE_MAX_AGE_MS = 6 * 60 * 60 * 1000

const REPO_ROOT = dirname(import.meta.dir)
const PROBE_ENTRY = import.meta.path
const SHIM_PATH = "~/.config/opencode/plugins/codemode-builtins-probe.ts"

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  id: string
  /** `options.codemode` as seen in the catalog (may be absent/undefined). */
  codemode: unknown
  /** `options.namespace` as seen in the catalog. */
  namespace: unknown
  /** Every key present on `options`, to prove we only added `codemode`. */
  optionKeys: string[]
}

export type CatalogViewName = "ctx.tool.list()" | "transform-post" | "transform-pre"

/** One catalog view the record holds; `entries: null` = the probe never captured it. */
export interface CatalogView {
  name: CatalogViewName
  entries: CatalogEntry[] | null
}

export interface DecideResolution {
  /** True only when a `decide`-shaped tool was actually seen in some view. */
  found: boolean
  id?: string
  namespace?: unknown
  /** `tools.typesafe.decide` when namespaced, else `tools.decide`. */
  codeModePath?: string
  /** Which catalog view the match came from (when found). */
  source?: CatalogViewName
  /**
   * Every view recorded for the report, with entry counts (`null` = not captured).
   * `resolveDecide` fills this for all views before it returns, so a view listed
   * after the match was not itself searched.
   */
  checked?: { view: CatalogViewName; entries: number | null }[]
  /**
   * decide-shaped ids that were seen but cannot be turned into a call path (their
   * prefix is not a single identifier segment). Presence here means the tool may
   * exist — it is *not* evidence of absence.
   */
  unresolved?: { id: string; reason: string }[]
  /** Human sentence. When `found` is false this says *unknown*, never a cause. */
  note: string
}

export interface DirectListSample {
  at: string
  sessionID: string
  agent: string
  /** Every tool the model request saw directly. */
  tools: string[]
  /** Which of the six built-ins were still on that direct list. */
  builtinsPresent: string[]
}

export interface ToolCallSample {
  at: string
  phase: "before" | "after"
  tool: string
  sessionID: string
  agent: string
  status?: string
}

export interface ProbeState {
  schema: 1
  pluginId: string
  loaded: true
  loadedAt: string
  app: { name: string; version: string; channel: string }
  directory: string
  /** Only the *keys* of the plugin options (never their values — may be secrets). */
  optionKeys: string[]
  transform: {
    runs: number
    lastRunAt?: string
    pre: CatalogEntry[]
    post: CatalogEntry[]
    report: FlipReport
  }
  /** `ctx.tool.list()` ("after every transform"), as an independent view. */
  catalogAfterTransforms: { at: string; entries: CatalogEntry[] } | null
  decide: DecideResolution | null
  directLists: DirectListSample[]
  toolCalls: ToolCallSample[]
  notes: string[]
}

const MAX_DIRECT_LISTS = 20
const MAX_TOOL_CALLS = 200

function nowIso(): string {
  return new Date().toISOString()
}

/** Read a structural catalog from either an editor or `ctx.tool.list()`. */
export function readCatalog(source: {
  list(): readonly { id: string; options?: unknown }[]
}): CatalogEntry[] {
  return source.list().map((tool) => {
    const opts = (tool.options ?? undefined) as Record<string, unknown> | undefined | null
    return {
      id: tool.id,
      codemode: opts?.codemode,
      namespace: opts?.namespace,
      optionKeys: opts === null || opts === undefined ? [] : Object.keys(opts),
    }
  })
}

/**
 * The tool leaf name for a catalog entry, stripping a leading `<namespace>` prefix
 * in whichever separator the host used (`typesafe_decide`, `typesafe.decide`,
 * `typesafe/decide` → all `decide`).
 */
function toolLeaf(entry: CatalogEntry): string {
  const ns = typeof entry.namespace === "string" && entry.namespace.length > 0 ? entry.namespace : undefined
  if (ns !== undefined) {
    for (const sep of ["_", ".", "/"]) {
      const prefix = ns + sep
      if (entry.id.startsWith(prefix)) return entry.id.slice(prefix.length)
    }
  }
  return entry.id
}

/** How a decide candidate's namespace was obtained, for the note. */
type NamespaceOrigin = "options" | "id" | "none"

/** A catalog entry that looks like the `decide` tool, with its resolved call path. */
interface DecideCandidate {
  entry: CatalogEntry
  /** Effective namespace for the call path (from `options.namespace`, else derived from the id). */
  namespace: string | undefined
  path: string
  namespaceFrom: NamespaceOrigin
  /** Lower is better: 0 = namespace `typesafe`, 1 = exact bare `decide`, 2 = any other namespace. */
  rank: number
}

/** `foo_decide`, `foo.decide`, `foo/decide` → the part before the separator is the namespace. */
const DECIDE_ID_SUFFIX = /^(?<prefix>.+)[_./]decide$/

/**
 * A derivable namespace must be a single identifier segment that contains no
 * separator (`_`, `.` or `/`): only then is the id's split point unambiguous and
 * `tools.<ns>.decide` callable syntax. `a_b_decide` (namespace `a_b`? `a` +
 * `b_decide`?), `a-b_decide` and `x.y_decide` all fail this and are reported as
 * seen-but-not-derivable instead of getting a guessed path.
 */
const DERIVABLE_NAMESPACE = /^[A-Za-z$][A-Za-z0-9$]*$/

/** A decide-shaped id that cannot be turned into a justified call path. */
interface UnresolvedDecide {
  id: string
  reason: string
}

/** Result of classifying one catalog entry. */
type DecidedEntry =
  | { kind: "resolved"; candidate: DecideCandidate }
  | { kind: "unresolved"; unresolved: UnresolvedDecide }
  | { kind: "other" }

/**
 * Classify one catalog entry. Every id spelling the host has been seen to use is
 * accepted; when `options.namespace` is absent but the id is `<ns>[_./]decide` and
 * `ns` is a single identifier segment, the namespace is derived from the id so the
 * reported call path is right (never a bare `tools.decide` for a namespaced tool).
 * A decide-shaped id whose prefix is not a valid identifier segment is reported as
 * `unresolved` — seen, not derivable — never silently dropped.
 */
function classifyDecide(entry: CatalogEntry): DecidedEntry {
  const optsNs = typeof entry.namespace === "string" && entry.namespace.length > 0 ? entry.namespace : undefined

  if (optsNs !== undefined) {
    // With an explicit namespace the leaf (after stripping that namespace prefix)
    // must be exactly `decide`; anything else is not the decide tool.
    if (toolLeaf(entry) !== "decide") return { kind: "other" }
    return {
      kind: "resolved",
      candidate: {
        entry,
        namespace: optsNs,
        path: `tools.${optsNs}.decide`,
        namespaceFrom: "options",
        rank: optsNs === "typesafe" ? 0 : 2,
      },
    }
  }

  if (entry.id === "decide") {
    return {
      kind: "resolved",
      candidate: { entry, namespace: undefined, path: "tools.decide", namespaceFrom: "none", rank: 1 },
    }
  }

  const match = DECIDE_ID_SUFFIX.exec(entry.id)
  const prefix = match?.groups?.prefix
  if (prefix === undefined) return { kind: "other" }

  if (!DERIVABLE_NAMESPACE.test(prefix)) {
    return {
      kind: "unresolved",
      unresolved: {
        id: entry.id,
        reason: `namespace prefix "${prefix}" is not a single separator-free identifier segment, so no call path can be derived`,
      },
    }
  }

  return {
    kind: "resolved",
    candidate: {
      entry,
      namespace: prefix,
      path: `tools.${prefix}.decide`,
      namespaceFrom: "id",
      rank: prefix === "typesafe" ? 0 : 2,
    },
  }
}

/**
 * Rank the decide candidates in one view: namespace `typesafe` first, then an exact
 * bare `decide`, then any other namespace; ties broken by id and then namespace so
 * the order is total even for duplicate ids. Every candidate is returned so the note
 * can name an ambiguity instead of silently picking one, and decide-shaped ids that
 * could not be classified ride along as `unresolved`.
 *
 * Ambiguity is view-scoped by construction: `resolveDecide` takes the first view
 * that yields a resolvable candidate and never merges candidates across views, so
 * the note's "in this view" wording is load-bearing.
 */
function chooseDecide(
  entries: CatalogEntry[],
): { best: DecideCandidate | undefined; others: DecideCandidate[]; unresolved: UnresolvedDecide[] } | undefined {
  const candidates: DecideCandidate[] = []
  const unresolved: UnresolvedDecide[] = []
  for (const entry of entries) {
    const decided = classifyDecide(entry)
    if (decided.kind === "resolved") candidates.push(decided.candidate)
    else if (decided.kind === "unresolved") unresolved.push(decided.unresolved)
  }
  if (candidates.length === 0 && unresolved.length === 0) return undefined
  if (candidates.length === 0) return { best: undefined, others: [], unresolved }
  const sorted = [...candidates].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0) ||
      byNamespace(a.namespace, b.namespace),
  )
  const [best, ...others] = sorted
  return { best: best as DecideCandidate, others, unresolved }
}

/** Total-order tie-break on the candidate's namespace. */
function byNamespace(a: string | undefined, b: string | undefined): number {
  const left = a ?? ""
  const right = b ?? ""
  return left === right ? 0 : left < right ? -1 : 1
}

function describeDecide(
  pick: { best: DecideCandidate; others: DecideCandidate[]; unresolved: UnresolvedDecide[] },
  source: CatalogViewName,
  checked: { view: CatalogViewName; entries: number | null }[],
): DecideResolution {
  const { best, others, unresolved } = pick
  const nsText =
    best.namespace === undefined
      ? "no namespace"
      : `namespace "${best.namespace}"${best.namespaceFrom === "id" ? " (derived from the id)" : ""}`
  // Only an alternative that resolves to a *different* call path is a real
  // ambiguity; two spellings that both yield best.path are not. The count is of
  // distinct alternative paths, not of ids.
  const distinct = others.filter((o) => o.path !== best.path)
  const ambiguity =
    distinct.length === 0
      ? ""
      : ` — ${distinct.length} other resolve target(s) in this view (${distinct
          .map((o) => `"${o.entry.id}" → ${o.path}`)
          .join(", ")}); picked by rank typesafe > bare decide > other namespace`
  const seenNotDerivable =
    unresolved.length === 0
      ? ""
      : `; ${unresolved.length} decide-shaped id(s) seen but not derivable (${unresolved.map((u) => `"${u.id}"`).join(", ")})`
  return {
    found: true,
    id: best.entry.id,
    namespace: best.namespace,
    codeModePath: best.path,
    source,
    checked,
    unresolved: unresolved.length === 0 ? undefined : unresolved,
    note: `matched catalog id "${best.entry.id}" (${nsText}) in the ${source} view → call it as ${best.path}${ambiguity}${seenNotDerivable}`,
  }
}

function unknownDecideNote(checked: { view: CatalogViewName; entries: number | null }[]): string {
  const listed =
    checked.length === 0
      ? "no catalog views recorded"
      : checked.map((c) => `${c.view}: ${c.entries === null ? "not captured" : `${c.entries} entries`}`).join("; ")
  return (
    "not visible in any catalog view the probe could read " +
    `(${listed}). The probe cannot tell whether it is absent or was registered after its snapshots — unknown, not a finding.`
  )
}

/** Note for a decide-shaped id that was seen but cannot be turned into a call path. */
function unresolvedDecideNote(view: CatalogViewName, unresolved: UnresolvedDecide[]): string {
  const listed = unresolved.map((u) => `"${u.id}" (${u.reason})`).join("; ")
  return `a decide-shaped id was seen in the ${view} view but its namespace cannot be derived, so no call path can be justified: ${listed}. This is not evidence of absence.`
}

/** The catalog views a record holds, most complete first. */
export function decideViews(state: ProbeState): CatalogView[] {
  const ran = state.transform.runs > 0
  return [
    { name: "ctx.tool.list()", entries: state.catalogAfterTransforms?.entries ?? null },
    { name: "transform-post", entries: ran ? state.transform.post : null },
    { name: "transform-pre", entries: ran ? state.transform.pre : null },
  ]
}

/**
 * Resolve `decide` from every view the record has, most complete first. A tool
 * registered by another plugin's transform can be missing from the probe's
 * transform-time snapshots while still live (the exact false-negative this fixes),
 * so we only report `found: false` after checking *all* views — and then only as
 * "unknown", never as a cause.
 *
 * The first view that yields a resolvable candidate wins; candidates are never
 * merged across views, so ambiguity is view-scoped (see `chooseDecide`).
 *
 * A decide-shaped id that cannot be classified (its namespace prefix is not a single
 * identifier segment) is carried as `unresolved`, not treated as absent: if no view
 * yields a resolvable candidate but some view held such an id, `found` is false and
 * the note says "seen but not derivable" instead of "not visible".
 */
export function resolveDecide(views: CatalogView[]): DecideResolution {
  // Record every view up front (no truncation on early return) so the report can
  // list all of them; which view matched is carried in `source`.
  const checked = views.map((v) => ({ view: v.name, entries: v.entries === null ? null : v.entries.length }))
  let seenNotDerivable: { view: CatalogViewName; unresolved: UnresolvedDecide[] } | undefined
  for (const view of views) {
    if (view.entries === null) continue
    const pick = chooseDecide(view.entries)
    if (pick === undefined) continue
    if (pick.best !== undefined) {
      return describeDecide({ best: pick.best, others: pick.others, unresolved: pick.unresolved }, view.name, checked)
    }
    // decide-shaped but not derivable here: remember it and keep looking.
    if (seenNotDerivable === undefined && pick.unresolved.length > 0) {
      seenNotDerivable = { view: view.name, unresolved: pick.unresolved }
    }
  }
  if (seenNotDerivable !== undefined) {
    return {
      found: false,
      checked,
      unresolved: seenNotDerivable.unresolved,
      note: unresolvedDecideNote(seenNotDerivable.view, seenNotDerivable.unresolved),
    }
  }
  return { found: false, checked, note: unknownDecideNote(checked) }
}

// ---------------------------------------------------------------------------
// Plugin face
// ---------------------------------------------------------------------------

const state: ProbeState = {
  schema: 1,
  pluginId: PROBE_PLUGIN_ID,
  loaded: true,
  loadedAt: nowIso(),
  app: { name: "unknown", version: "unknown", channel: "unknown" },
  directory: "unknown",
  optionKeys: [],
  transform: { runs: 0, pre: [], post: [], report: { flipped: [], already: [], skipped: [] } },
  catalogAfterTransforms: null,
  decide: null,
  directLists: [],
  toolCalls: [],
  notes: [],
}

let writeChain: Promise<void> = Promise.resolve()

function persist(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2)
  writeChain = writeChain
    .then(() => mkdir(dirname(PROBE_STATE_PATH), { recursive: true }))
    .then(() => writeFile(PROBE_STATE_PATH, snapshot, "utf8"))
    .catch((error: unknown) => {
      // Never let probe bookkeeping break the host.
      console.error(`[${PROBE_PLUGIN_ID}] could not write ${PROBE_STATE_PATH}: ${String(error)}`)
    })
  return writeChain
}

/**
 * Recompute `decide` from *all* views captured so far. Called after each
 * transform and after the `ctx.tool.list()` snapshot, so the record reflects the
 * most complete view rather than whichever transform happened to run first.
 */
function refreshDecide(): void {
  state.decide = resolveDecide(decideViews(state))
}

/**
 * The host's editor type, pulled out of the V2 plugin contract so we adapt to it
 * without importing anything at runtime.
 */
type HostEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

/**
 * Adapt the host's `ToolEditor` to the frozen `ToolEditorLike`. The host types
 * `options` as a union without an index signature, so the contract's
 * `Record<string, unknown>` needs this one boundary cast (see the final report).
 */
function adaptEditor(editor: HostEditor): ToolEditorLike {
  return {
    list: () => editor.list(),
    update: (id, fn) => editor.update(id, (tool) => fn(tool as { options?: Record<string, unknown> | null })),
  }
}

const plugin: Plugin.Plugin = {
  id: PROBE_PLUGIN_ID,
  async setup(ctx: Plugin.Context) {
    state.loaded = true
    state.loadedAt = nowIso()
    state.app = { name: ctx.app.name, version: ctx.app.version, channel: ctx.app.channel }
    state.directory = ctx.location.directory
    state.optionKeys = Object.keys((ctx.options ?? {}) as Record<string, unknown>)
    state.transform = { runs: 0, pre: [], post: [], report: { flipped: [], already: [], skipped: [] } }

    console.log(
      `[${PROBE_PLUGIN_ID}] loaded in ${state.app.name} ${state.app.version} (${state.app.channel}); record → ${PROBE_STATE_PATH}`,
    )
    await persist()

    // (1)(2) the flip: observe the catalog immediately before and after.
    await ctx.tool.transform((editor) => {
      const view = adaptEditor(editor)
      const pre = readCatalog(view)
      const report = enableBuiltinsForCodeMode(view, { enabled: true, ids: BUILTIN_FILE_SHELL_IDS })
      const post = readCatalog(view)
      state.transform = { runs: state.transform.runs + 1, lastRunAt: nowIso(), pre, post, report }
      refreshDecide()
      console.log(
        `[${PROBE_PLUGIN_ID}] transform run #${state.transform.runs}: flipped=[${report.flipped.join(",")}] already=[${report.already.join(",")}] skipped=[${report.skipped.map((s) => s.id).join(",")}]`,
      )
      void persist()
    })

    // Independent "after every transform" view; transforms may run lazily.
    const snapshotSoon = () =>
      void ctx.tool
        .list()
        .then((tools) => {
          state.catalogAfterTransforms = {
            at: nowIso(),
            entries: readCatalog({ list: () => tools as readonly { id: string; options?: unknown }[] }),
          }
          refreshDecide()
          return persist()
        })
        .catch(() => {})
    setTimeout(snapshotSoon, 1000)

    // (5) every tool call the host admits — nested sandbox calls included.
    await ctx.tool.hook("execute.before", (event) => {
      state.toolCalls.push({
        at: nowIso(),
        phase: "before",
        tool: event.tool,
        sessionID: String(event.sessionID),
        agent: String(event.agent),
      })
      trim()
      void persist()
    })
    await ctx.tool.hook("execute.after", (event) => {
      state.toolCalls.push({
        at: nowIso(),
        phase: "after",
        tool: event.tool,
        sessionID: String(event.sessionID),
        agent: String(event.agent),
        status: event.status,
      })
      trim()
      void persist()
    })

    // (3) the model-facing "direct" tool list, captured per request.
    await ctx.session.hook("context", (event) => {
      const tools = Object.keys(event.tools ?? {})
      const builtinsPresent = BUILTIN_FILE_SHELL_IDS.filter((id) => tools.includes(id))
      state.directLists.push({
        at: nowIso(),
        sessionID: String(event.sessionID),
        agent: String(event.agent),
        tools,
        builtinsPresent,
      })
      if (state.directLists.length > MAX_DIRECT_LISTS) state.directLists.shift()
      void persist()
    })

    return () => {
      // Keep the record; a restart is meant to overwrite it.
    }
  },
}

function trim(): void {
  if (state.toolCalls.length > MAX_TOOL_CALLS) state.toolCalls.splice(0, state.toolCalls.length - MAX_TOOL_CALLS)
}

export default plugin

// ---------------------------------------------------------------------------
// CLI face
// ---------------------------------------------------------------------------

async function load(): Promise<ProbeState | undefined> {
  try {
    return JSON.parse(await readFile(PROBE_STATE_PATH, "utf8")) as ProbeState
  } catch {
    return undefined
  }
}

function line(char = "-"): string {
  return char.repeat(72)
}

function refuse(reason: string, body: string, code = 1): never {
  console.error("")
  console.error(`✗ live-builtins probe: ${reason}`)
  console.error(line("="))
  console.error(body)
  console.error(line("="))
  process.exit(code)
}

function shimBlock(): string {
  return [
    "Paste this shim (creates the file):",
    "",
    `  mkdir -p ~/.config/opencode/plugins`,
    `  cat > ${SHIM_PATH} <<'SHIM'`,
    `export { default } from "${PROBE_ENTRY}"`,
    "SHIM",
    "",
    "Then restart the host so discovery picks it up:",
    "",
    "  opencode service restart",
    "",
    `(From this checkout, the probe is at ${PROBE_ENTRY} — repo root ${REPO_ROOT}.)`,
  ].join("\n")
}

function freshEnough(state: ProbeState): { ok: boolean; ageMs: number } {
  const loadedAt = Date.parse(state.loadedAt)
  if (Number.isNaN(loadedAt)) return { ok: false, ageMs: Number.POSITIVE_INFINITY }
  return { ok: true, ageMs: Date.now() - loadedAt }
}

function renderSection(title: string, tags: string): void {
  console.log("")
  console.log(line("="))
  console.log(tags)
  console.log(title)
  console.log(line("="))
}

function formatCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "  (empty)"
  return entries
    .map((e) => {
      const cm = e.codemode === undefined ? "absent" : String(e.codemode)
      return `  - ${e.id}: codemode=${cm}, namespace=${e.namespace === undefined ? "none" : String(e.namespace)}, options=[${e.optionKeys.join(", ")}]`
    })
    .join("\n")
}

function fmtReport(report: FlipReport): string {
  return [
    `  flipped: [${report.flipped.join(", ")}]`,
    `  already: [${report.already.join(", ")}]`,
    `  skipped: [${report.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}]`,
  ].join("\n")
}

function printReport(state: ProbeState): void {
  console.log("")
  console.log(line("#"))
  console.log("# live-builtins probe report")
  console.log(`# record: ${PROBE_STATE_PATH}`)
  console.log(`# host loaded plugin at ${state.loadedAt} (host clock)`)
  console.log(`# host: ${state.app.name} ${state.app.version} (${state.app.channel}) in ${state.directory}`)
  console.log(line("#"))

  renderSection("(1) pre-flip catalog state of the six built-ins", "[AUTOMATED — recorded inside the host's tool transform]")
  console.log(`transform runs observed: ${state.transform.runs}`)
  console.log("pre-flip (read from editor.list() BEFORE the flip):")
  console.log(formatCatalog(state.transform.pre))
  console.log("")
  console.log("what to look for: each of read/grep/glob/shell/edit/write should show codemode=false (not `true`).")
  console.log("if this list is empty, the transform did not observe a populated catalog.")

  renderSection("(2) post-flip catalog", "[AUTOMATED]")
  console.log("flip report:")
  console.log(fmtReport(state.transform.report))
  console.log("")
  console.log("post-flip (read from editor.list() AFTER the flip, same transform run):")
  console.log(formatCatalog(state.transform.post))
  console.log("")
  console.log("independent view from ctx.tool.list() (after every transform):")
  if (state.catalogAfterTransforms === null) {
    console.log("  (not captured yet — the host may not have materialized the tool list)")
  } else {
    console.log(`  at ${state.catalogAfterTransforms.at}:`)
    console.log(formatCatalog(state.catalogAfterTransforms.entries))
  }
  console.log("")
  console.log("what to look for: the six should now show codemode=true; options=[...] should still contain")
  console.log("every key the host put there (namespace, permission, pinned, ...) — only `codemode` was added.")

  renderSection("(3) exclusivity: are the six still on the agent's DIRECT tool list?", "[AUTOMATED capture, HUMAN-triggered request]")
  if (state.directLists.length === 0) {
    console.log("PENDING — no model request observed yet, so the direct tool list is unknown.")
    console.log("")
    console.log("HUMAN step: send any message in the TUI (e.g. `say hi`). That single request lets the")
    console.log("`session.context` hook record the tool map the model was offered. Then re-run `bun run probe`.")
  } else {
    for (const [index, sample] of state.directLists.entries()) {
      console.log(`request #${index + 1}  agent=${sample.agent}  ${sample.at}`)
      console.log(`  direct tools (${sample.tools.length}): ${sample.tools.join(", ") || "(none)"}`)
      console.log(`  of the six, still direct: [${sample.builtinsPresent.join(", ")}]`)
    }
    console.log("")
    const informative = state.directLists.filter((s) => s.tools.length > 0)
    if (informative.length === 0) {
      console.log("UNKNOWN — every recorded request exposed an empty direct tool list, so the probe cannot")
      console.log("tell whether the six were removed from the native list or simply not visible from this hook.")
    } else {
      const everPresent = new Set(informative.flatMap((s) => s.builtinsPresent))
      console.log(`(using the ${informative.length} of ${state.directLists.length} request(s) that exposed a non-empty tool list)`)
      if (everPresent.size === 0) {
        console.log("INTERPRETATION: across those requests none of the six appeared on the direct list →")
        console.log("consistent with codemode REMOVING them from the native list (either/or).")
      } else {
        console.log(`INTERPRETATION: still direct: [${[...everPresent].join(", ")}] → they COEXIST (native + sandbox).`)
      }
      console.log("Cross-check by eye in the TUI: for the ids reported absent, the tool picker should not list them.")
    }
  }

  // Recompute from every view in the record: a tool added by another plugin's
  // transform can be missing from our transform-time snapshots while still live.
  const decide = resolveDecide(decideViews(state))
  renderSection("(4) effective Code Mode path of decide", "[AUTOMATED]")
  if (!decide.found) {
    const unresolved = decide.unresolved ?? []
    if (unresolved.length > 0) {
      console.log("SEEN BUT NOT DERIVABLE — a decide-shaped id is in the catalog, but its namespace cannot")
      console.log("be derived from the id, so no call path can be justified:")
      for (const u of unresolved) console.log(`  - ${u.id}: ${u.reason}`)
      console.log("")
      console.log("This is NOT evidence of absence: the tool may live under a namespace that contains a")
      console.log("separator. Inspect the raw catalog (`bun run probe --json`) or call the path explicitly.")
    } else {
      console.log("UNKNOWN — decide is not visible from any catalog view this probe captured.")
      console.log("")
      console.log("This is NOT evidence that a plugin is missing: a tool added by another plugin's")
      console.log("transform can be absent from the probe's snapshots while still live in Code Mode.")
      console.log("The probe cannot establish the cause from what it recorded.")
    }
    console.log("")
    console.log("views checked:")
    for (const c of decide.checked ?? []) {
      console.log(`  - ${c.view}: ${c.entries === null ? "not captured" : `${c.entries} entries`}`)
    }
  } else {
    console.log(`id: ${decide.id}`)
    console.log(`namespace: ${decide.namespace === undefined ? "(none)" : String(decide.namespace)}`)
    console.log(`seen in: ${decide.source}`)
    console.log(`→ call it as: ${decide.codeModePath}`)
    console.log(`note: ${decide.note}`)
  }
  console.log("")
  console.log("HUMAN confirmation: in a Code Mode script, `typeof tools.X.decide` lies; only calling reveals")
  console.log("absence. Expected: `await tools.typesafe.decide({...})` unless (4) says tools.decide.")

  renderSection("(5) does a nested sandbox `read` still trip the leaf permission?", "[AUTOMATED capture, HUMAN-observed permission]")
  const readCalls = state.toolCalls.filter((c) => c.tool === "read")
  const sandboxReads = readCalls.filter((c) => c.phase === "before")
  if (sandboxReads.length === 0) {
    console.log("PENDING — no `read` tool call recorded yet.")
    console.log("")
    console.log("HUMAN step (does NOT call a model — it runs inside an existing session's Code Mode sandbox):")
    console.log("  In a session with this plugin loaded, run a Code Mode script such as:")
    console.log("    const r = await tools.read({ path: \"/tmp/opencode/probe-read.txt\" })")
    console.log("    return r")
    console.log("  (create that file first, e.g. `echo probe > /tmp/opencode/probe-read.txt`).")
    console.log("  If the agent's permission mode asks for shell/read approval, the prompt appearing is the answer.")
    console.log("  Then re-run `bun run probe` to see the tool-call capture below.")
  } else {
    console.log(`read calls seen in the host's tool pipeline: ${sandboxReads.length}`)
    for (const call of readCalls.slice(-10)) console.log(`  ${call.at} ${call.phase} agent=${call.agent} status=${call.status ?? "-"}`)
    console.log("")
    console.log("INTERPRETATION: a `read` execute.before/after shows a read call reached the host's tool pipeline.")
    console.log("This record alone cannot say whether it came from inside the sandbox or from a direct call.")
    console.log("If it came from the sandbox, then the sandbox call entered the pipeline; whether a leaf")
    console.log("permission check fires for it is what the TUI prompt observation confirms, not this record.")
  }

  renderSection("raw summary", "[AUTOMATED]")
  console.log(`transform runs: ${state.transform.runs}`)
  console.log(`tool calls seen: ${state.toolCalls.length}`)
  console.log(`model requests observed: ${state.directLists.length}`)
  console.log(`never-flip ids (always skipped): [${NEVER_FLIP_IDS.join(", ")}]`)

  const incomplete: string[] = []
  if (state.transform.runs === 0) incomplete.push("(1)(2) tool transform never ran")
  if (state.directLists.length === 0) incomplete.push("(3) direct tool list not observed (send a message)")
  if (!decide.found) {
    incomplete.push(
      (decide.unresolved ?? []).length > 0
        ? "(4) decide-shaped id seen but its namespace is not derivable"
        : "(4) decide path unknown — not visible in any catalog view the probe read",
    )
  }
  if (sandboxReads.length === 0) incomplete.push("(5) nested read not run")
  console.log("")
  if (incomplete.length === 0) {
    console.log("✓ all five questions have data.")
  } else {
    console.log("⚠ incomplete — still pending:")
    for (const item of incomplete) console.log(`  - ${item}`)
  }
  console.log("")
  console.log("Reminder: (1)(2)(4) are automated by the loaded plugin; (3)(5) need the HUMAN steps above;")
  console.log("the permission prompt and the TUI tool list are observed by eye.")
}

async function main(argv: string[]): Promise<void> {
  const allowStale = argv.includes("--allow-stale")
  const asJson = argv.includes("--json")

  const state = await load()

  if (state === undefined || state.loaded !== true) {
    refuse(
      "the host did not load this plugin (no record found)",
      [
        `No probe record at ${PROBE_STATE_PATH}.`,
        "",
        "This probe must be loaded by a live OpenCode host before it can report anything.",
        "It deliberately refuses to run otherwise, so an unloaded probe can never look like a pass.",
        "",
        shimBlock(),
        "",
        "After the restart, do the human steps (send a message; run a nested read from Code Mode),",
        "then run `bun run probe` again.",
      ].join("\n"),
    )
  }

  const age = freshEnough(state)
  if (!age.ok) {
    refuse("the probe record is unreadable (bad loadedAt)", `Record at ${PROBE_STATE_PATH} has no parseable loadedAt.`)
  }
  if (age.ageMs > PROBE_MAX_AGE_MS && !allowStale) {
    refuse(
      "the probe record is stale",
      [
        `The host loaded the plugin ${Math.round(age.ageMs / 60000)} minutes ago (older than ${PROBE_MAX_AGE_MS / 3600000}h).`,
        "Restart the host (`opencode service restart`), redo the steps, and re-run.",
        "Pass --allow-stale to inspect the old record anyway.",
      ].join("\n"),
      2,
    )
  }

  if (state.transform.runs === 0 && !allowStale) {
    console.error(
      [
        "",
        "✗ live-builtins probe: the plugin was loaded but no tool transform was observed.",
        `Record: ${PROBE_STATE_PATH} (loaded ${state.loadedAt}).`,
        "The host may not have materialized the tool catalog yet. Restart the host and re-run,",
        "or pass --allow-stale to print what little was captured.",
        "",
      ].join("\n"),
    )
    process.exit(3)
  }

  if (asJson) {
    // Recompute `decide` so the JSON agrees with the printed report for records
    // written by any plugin version — old records persisted a stale (and, in the
    // live false negative, actively wrong) `decide` field. CONTRACTS.md §2 defines
    // the probe's required outputs but does not require --json to be a raw dump.
    console.log(JSON.stringify({ ...state, decide: resolveDecide(decideViews(state)) }, null, 2))
    return
  }

  printReport(state)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`live-builtins probe failed: ${String(error)}`)
    process.exit(70)
  })
}
