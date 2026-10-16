import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROBE_MAX_AGE_MS, readCatalog, resolveDecidePath, type ProbeState } from "./live-builtins.ts"

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

describe("resolveDecidePath", () => {
  test("namespaced decide → tools.<ns>.decide", () => {
    const out = resolveDecidePath([{ id: "decide", codemode: true, namespace: "typesafe", optionKeys: ["namespace"] }])
    expect(out.found).toBe(true)
    expect(out.codeModePath).toBe("tools.typesafe.decide")
  })

  test("un-namespaced decide → tools.decide", () => {
    const out = resolveDecidePath([{ id: "decide", codemode: true, namespace: undefined, optionKeys: [] }])
    expect(out.codeModePath).toBe("tools.decide")
  })

  test("absent decide is reported, never guessed", () => {
    const out = resolveDecidePath([{ id: "read", codemode: true, namespace: undefined, optionKeys: [] }])
    expect(out.found).toBe(false)
    expect(out.codeModePath).toBeUndefined()
    expect(out.note).toContain("not in the catalog")
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
