import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROBE_MAX_AGE_MS,
  decideViews,
  readCatalog,
  resolveDecide,
  type CatalogEntry,
  type CatalogView,
  type ProbeState,
} from "./live-builtins.ts"

describe("readCatalog", () => {
  test("reads id, codemode, namespace and every option key", () => {
    const entries = readCatalog({
      list: () => [
        { id: "read", options: { codemode: false, namespace: "fs", permission: "read" } },
        { id: "grep", options: null },
        { id: "glob" },
      ],
    })
    expect(entries).toEqual([
      { id: "read", codemode: false, namespace: "fs", optionKeys: ["codemode", "namespace", "permission"] },
      { id: "grep", codemode: undefined, namespace: undefined, optionKeys: [] },
      { id: "glob", codemode: undefined, namespace: undefined, optionKeys: [] },
    ])
  })

  test("does not confuse false with absent", () => {
    const [entry] = readCatalog({ list: () => [{ id: "read", options: { codemode: false } }] })
    expect(entry?.codemode).toBe(false)
  })
})

/** Resolve decide from a single view; the multi-view case is covered further down. */
const resolveOne = (entries: CatalogEntry[]): ReturnType<typeof resolveDecide> =>
  resolveDecide([{ name: "transform-post", entries }])

describe("decide resolution (single view)", () => {
  test("namespaced decide → tools.<ns>.decide", () => {
    const out = resolveOne([{ id: "decide", codemode: true, namespace: "typesafe", optionKeys: ["namespace"] }])
    expect(out.found).toBe(true)
    expect(out.codeModePath).toBe("tools.typesafe.decide")
  })

  test("un-namespaced decide → tools.decide", () => {
    const out = resolveOne([{ id: "decide", codemode: true, namespace: undefined, optionKeys: [] }])
    expect(out.codeModePath).toBe("tools.decide")
  })

  test("absent decide is reported as unknown, never as a cause", () => {
    const out = resolveOne([{ id: "read", codemode: true, namespace: undefined, optionKeys: [] }])
    expect(out.found).toBe(false)
    expect(out.codeModePath).toBeUndefined()
    expect(out.note).toContain("not visible")
    expect(out.note).toContain("unknown")
    expect(out.note).not.toContain("not loaded")
  })

  test("#8 an empty view list renders without a dangling '()'", () => {
    const out = resolveDecide([])
    expect(out.found).toBe(false)
    expect(out.note).toContain("no catalog views recorded")
    expect(out.note).not.toContain("()")
  })
})

// ---------------------------------------------------------------------------
// CLI exit-code contract: an unloaded probe must never look like a pass.
// ---------------------------------------------------------------------------

const PROBE_FILE = join(import.meta.dir, "live-builtins.ts")

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "probe-test-")), "record.json")
}

function makeState(overrides: Partial<ProbeState> = {}): ProbeState {
  const at = new Date().toISOString()
  return {
    schema: 1,
    pluginId: "codemode-builtins-probe",
    loaded: true,
    loadedAt: at,
    app: { name: "opencode", version: "2.0.30", channel: "test" },
    directory: "/tmp",
    optionKeys: [],
    transform: { runs: 1, lastRunAt: at, pre: [], post: [], report: { flipped: [], already: [], skipped: [] } },
    catalogAfterTransforms: null,
    decide: null,
    directLists: [],
    toolCalls: [],
    notes: [],
    ...overrides,
  }
}

function runCli(stateFile: string, extra: string[] = []) {
  return Bun.spawnSync({
    cmd: ["bun", PROBE_FILE, ...extra],
    env: { ...process.env, OPENCODE_DECIDE_PROBE_FILE: stateFile },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function out(result: ReturnType<typeof runCli>): { stdout: string; stderr: string; code: number } {
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.exitCode ?? -1,
  }
}

describe("live-builtins CLI", () => {
  test("refuses (exit 1) when the host never loaded the plugin", () => {
    const file = tmpStateFile() // never written
    const result = out(runCli(file))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("did not load this plugin")
    expect(result.stderr).toContain("opencode service restart")
  })

  test("refuses (exit 1) when the record is missing the loaded marker", () => {
    const file = tmpStateFile()
    writeFileSync(file, JSON.stringify({ schema: 1 }))
    const result = out(runCli(file))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("did not load this plugin")
  })

  test("refuses (exit 2) when the record is stale, unless --allow-stale", () => {
    const file = tmpStateFile()
    const stale = new Date(Date.now() - PROBE_MAX_AGE_MS - 60_000).toISOString()
    writeFileSync(file, JSON.stringify(makeState({ loadedAt: stale })))
    expect(out(runCli(file)).code).toBe(2)
    expect(out(runCli(file, ["--allow-stale"])).code).toBe(0)
  })

  test("refuses (exit 3) when loaded but no transform ran", () => {
    const file = tmpStateFile()
    writeFileSync(
      file,
      JSON.stringify(makeState({ transform: { runs: 0, pre: [], post: [], report: { flipped: [], already: [], skipped: [] } } })),
    )
    const result = out(runCli(file))
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("no tool transform was observed")
  })

  test("prints all five sections (exit 0) for a complete record", () => {
    const file = tmpStateFile()
    writeFileSync(file, JSON.stringify(makeState()))
    const result = out(runCli(file))
    expect(result.code).toBe(0)
    for (const heading of ["(1) pre-flip", "(2) post-flip", "(3) exclusivity", "(4) effective Code Mode path", "(5) does a nested sandbox"]) {
      expect(result.stdout).toContain(heading)
    }
    expect(result.stdout).toContain("HUMAN")
  })

  test("--json dumps the record without the report", () => {
    const file = tmpStateFile()
    writeFileSync(file, JSON.stringify(makeState()))
    const result = out(runCli(file, ["--json"]))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).pluginId).toBe("codemode-builtins-probe")
  })
})

// ---------------------------------------------------------------------------
// decide detection. The probe's transform-time snapshot can miss a tool that
// another plugin's transform adds later (the live false negative), the id
// spelling varies, and absence must be reported as unknown — never as a cause.
// ---------------------------------------------------------------------------

const entry = (id: string, namespace?: string): CatalogEntry => ({
  id,
  codemode: true,
  namespace,
  optionKeys: namespace === undefined ? ["codemode"] : ["namespace", "codemode"],
})

describe("decide detection", () => {
  test("#2 a namespaced id without options.namespace derives the namespace", () => {
    const out = resolveOne([entry("typesafe_decide")])
    expect(out.found).toBe(true)
    expect(out.id).toBe("typesafe_decide")
    expect(out.codeModePath).toBe("tools.typesafe.decide")
  })

  test("#2 an id-derived namespace is never reported as bare tools.decide", () => {
    const out = resolveOne([entry("foo_decide")])
    expect(out.found).toBe(true)
    expect(out.codeModePath).toBe("tools.foo.decide")
    expect(out.codeModePath).not.toBe("tools.decide")
  })

  test("#2 a non-decide leaf under a namespace is not a candidate", () => {
    expect(resolveOne([entry("typesafe_something_decide", "typesafe")]).found).toBe(false)
  })

  test("accepts dot/slash spellings, with or without options.namespace", () => {
    expect(resolveOne([entry("typesafe.decide", "typesafe")]).codeModePath).toBe("tools.typesafe.decide")
    expect(resolveOne([entry("typesafe/decide", "typesafe")]).codeModePath).toBe("tools.typesafe.decide")
    expect(resolveOne([entry("typesafe.decide")]).codeModePath).toBe("tools.typesafe.decide")
  })

  test("#3 an exact bare decide beats a derived-namespace id, and names the ambiguity", () => {
    const out = resolveOne([entry("decide"), entry("foo_decide")])
    expect(out.codeModePath).toBe("tools.decide")
    expect(out.note).toContain("other decide-shaped")
    expect(out.note).toContain("foo_decide")
  })

  test("#3 typesafe beats a bare decide, and names the ambiguity", () => {
    const out = resolveOne([entry("decide"), entry("typesafe_decide", "typesafe")])
    expect(out.codeModePath).toBe("tools.typesafe.decide")
    expect(out.note).toContain("other decide-shaped")
  })

  test("#3 the ranking is deterministic regardless of catalog order", () => {
    const forward = resolveOne([entry("typesafe_decide", "typesafe"), entry("decide"), entry("zzz_decide")])
    const reversed = resolveOne([entry("zzz_decide"), entry("decide"), entry("typesafe_decide", "typesafe")])
    expect(forward.codeModePath).toBe("tools.typesafe.decide")
    expect(reversed.codeModePath).toBe("tools.typesafe.decide")
  })

  test("THE BUG: present only in the later ctx.tool.list() view → still found", () => {
    const views: CatalogView[] = [
      { name: "ctx.tool.list()", entries: [entry("read"), entry("typesafe_decide", "typesafe")] },
      { name: "transform-post", entries: [entry("read")] },
      { name: "transform-pre", entries: [entry("read")] },
    ]
    const out = resolveDecide(views)
    expect(out.found).toBe(true)
    expect(out.codeModePath).toBe("tools.typesafe.decide")
    expect(out.source).toBe("ctx.tool.list()")
  })

  test("absent from every view → unknown, and never says 'not loaded'", () => {
    const views: CatalogView[] = [
      { name: "ctx.tool.list()", entries: [entry("read")] },
      { name: "transform-post", entries: [entry("read")] },
      { name: "transform-pre", entries: [] },
    ]
    const out = resolveDecide(views)
    expect(out.found).toBe(false)
    expect(out.codeModePath).toBeUndefined()
    expect(out.note.toLowerCase()).toContain("unknown")
    expect(out.note).not.toContain("not loaded")
    expect(out.checked?.map((c) => c.view)).toEqual(["ctx.tool.list()", "transform-post", "transform-pre"])
  })

  test("decideViews() orders the record's views most-complete first", () => {
    const state = makeState({
      catalogAfterTransforms: { at: "t", entries: [entry("typesafe_decide", "typesafe")] },
      transform: { runs: 1, pre: [entry("read")], post: [entry("read")], report: { flipped: [], already: [], skipped: [] } },
    })
    expect(decideViews(state).map((v) => v.name)).toEqual(["ctx.tool.list()", "transform-post", "transform-pre"])
  })

  test("#7 checked lists every view even when the match is in the first", () => {
    const views: CatalogView[] = [
      { name: "ctx.tool.list()", entries: [entry("typesafe_decide", "typesafe")] },
      { name: "transform-post", entries: [entry("read")] },
      { name: "transform-pre", entries: [] },
    ]
    const out = resolveDecide(views)
    expect(out.checked?.map((c) => c.view)).toEqual(["ctx.tool.list()", "transform-post", "transform-pre"])
    expect(out.checked?.[1]?.entries).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The stored `state.decide` field of an old record must never leak the false
// accusation into the CLI output — neither the report nor --json.
// ---------------------------------------------------------------------------

const OLD_ACCUSATION = {
  found: false,
  note: "decide tool not in the catalog — the main plugin (src/index.ts) is not loaded in this host.",
}

const stateFromOldPlugin = () =>
  makeState({
    decide: OLD_ACCUSATION,
    transform: { runs: 1, pre: [entry("read")], post: [entry("read")], report: { flipped: [], already: [], skipped: [] } },
    catalogAfterTransforms: {
      at: new Date().toISOString(),
      entries: [entry("read"), entry("typesafe_decide", "typesafe")],
    },
  })

describe("live-builtins CLI: decide honesty (#1, #6)", () => {
  test("#6 a stored false accusation is ignored; the report shows the resolved path", () => {
    const file = tmpStateFile()
    writeFileSync(file, JSON.stringify(stateFromOldPlugin()))
    const result = out(runCli(file))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("tools.typesafe.decide")
    expect(result.stdout).toContain("seen in: ctx.tool.list()")
    expect(result.stdout).not.toContain("not loaded")
  })

  test("#1 --json also carries the recomputed decide, not the stale accusation", () => {
    const file = tmpStateFile()
    writeFileSync(file, JSON.stringify(stateFromOldPlugin()))
    const result = out(runCli(file, ["--json"]))
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("not loaded")
    const record = JSON.parse(result.stdout)
    expect(record.decide.found).toBe(true)
    expect(record.decide.codeModePath).toBe("tools.typesafe.decide")
    // The rest of the raw record is preserved alongside the recomputed field.
    expect(record.pluginId).toBe("codemode-builtins-probe")
    expect(record.catalogAfterTransforms.entries.length).toBe(2)
    expect(record.transform.runs).toBe(1)
  })

  test("#6 a not-captured view renders as 'not captured' in section (4)", () => {
    const file = tmpStateFile()
    writeFileSync(
      file,
      JSON.stringify(
        makeState({
          transform: { runs: 1, pre: [entry("read")], post: [entry("read")], report: { flipped: [], already: [], skipped: [] } },
          catalogAfterTransforms: null,
        }),
      ),
    )
    const result = out(runCli(file))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("ctx.tool.list(): not captured")
  })

  test("#6 decide absent from every view says UNKNOWN and never claims 'not loaded'", () => {
    const file = tmpStateFile()
    writeFileSync(
      file,
      JSON.stringify(
        makeState({
          decide: OLD_ACCUSATION,
          transform: { runs: 1, pre: [entry("read")], post: [entry("read")], report: { flipped: [], already: [], skipped: [] } },
          catalogAfterTransforms: { at: new Date().toISOString(), entries: [entry("read")] },
        }),
      ),
    )
    const result = out(runCli(file))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("UNKNOWN")
    expect(result.stdout).toContain("views checked")
    expect(result.stdout).not.toContain("not loaded")
    expect(result.stdout).not.toContain("is not loaded")
  })
})
