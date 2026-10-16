import { describe, expect, test } from "bun:test"
import {
  BUILTIN_FILE_SHELL_IDS,
  NEVER_FLIP_IDS,
  enableBuiltinsForCodeMode,
  type ToolEditorLike,
} from "./builtins.ts"

/** A catalog entry as stored by the fake editor (keeps non-options fields too). */
interface FakeTool {
  id: string
  name: string
  options?: Record<string, unknown> | null
}

/**
 * Fake V2 tool editor. `update` mutates the stored tool in place (like the host
 * does), and both `add`/`remove` are recorded so tests can assert they are never
 * called (they are outside the `ToolEditorLike` contract the function sees).
 */
function fakeEditor(initial: FakeTool[]) {
  const tools = new Map<string, FakeTool>(
    initial.map((t) => [t.id, { ...t, options: t.options === undefined ? undefined : { ...t.options } }]),
  )
  const calls = { list: 0, update: [] as string[], add: [] as string[], remove: [] as string[] }

  const editor: ToolEditorLike = {
    list() {
      calls.list++
      return [...tools.values()]
    },
    update(id, fn) {
      const tool = tools.get(id)
      if (tool === undefined) return
      calls.update.push(id)
      fn(tool as { options?: Record<string, unknown> | null })
    },
  }

  // The real V2 editor also exposes `add`/`remove`; attach them so tests can
  // prove the transform never reaches beyond `list`/`update`. They are not part
  // of `ToolEditorLike`, which is exactly why the function cannot call them.
  const withExtras = editor as ToolEditorLike & {
    add(def: { id: string }): void
    remove(id: string): void
  }
  withExtras.add = (def) => calls.add.push(def.id)
  withExtras.remove = (id) => calls.remove.push(id)

  return { editor: withExtras, tools, calls }
}

const ALL = [...BUILTIN_FILE_SHELL_IDS]

function withBuiltins(codemode: boolean, extra: Partial<Record<string, unknown>> = {}): FakeTool[] {
  return ALL.map((id) => ({ id, name: id, options: { codemode, ...extra } }))
}

describe("enableBuiltinsForCodeMode", () => {
  test("enabled: false is a strict no-op and does not touch the editor", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    const report = enableBuiltinsForCodeMode(editor, { enabled: false })
    expect(report).toEqual({ flipped: [], already: [], skipped: [] })
    expect(calls.list).toBe(0)
    expect(calls.update).toEqual([])
  })

  test("no opts at all is a strict no-op (default OFF)", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    expect(enableBuiltinsForCodeMode(editor)).toEqual({ flipped: [], already: [], skipped: [] })
    expect(calls.list).toBe(0)
    expect(calls.update).toEqual([])
  })

  test("flip happy path: flips every requested built-in", () => {
    const { editor, tools, calls } = fakeEditor(withBuiltins(false))
    const report = enableBuiltinsForCodeMode(editor, { enabled: true })
    expect(report.flipped.sort()).toEqual([...ALL].sort())
    expect(report.already).toEqual([])
    expect(report.skipped).toEqual([])
    expect(calls.update.sort()).toEqual([...ALL].sort())
    for (const id of ALL) expect(tools.get(id)?.options?.codemode).toBe(true)
  })

  test("already: codemode: true is reported, never re-updated", () => {
    const { editor, calls } = fakeEditor(withBuiltins(true))
    const report = enableBuiltinsForCodeMode(editor, { enabled: true })
    expect(report.already.sort()).toEqual([...ALL].sort())
    expect(report.flipped).toEqual([])
    expect(report.skipped).toEqual([])
    expect(calls.update).toEqual([])
  })

  test("missing id is skipped, present siblings still flip", () => {
    const { editor, tools } = fakeEditor([
      { id: "read", name: "read", options: { codemode: false } },
      { id: "grep", name: "grep", options: { codemode: true } },
    ])
    const report = enableBuiltinsForCodeMode(editor, { enabled: true, ids: ["read", "grep", "nope"] })
    expect(report.flipped).toEqual(["read"])
    expect(report.already).toEqual(["grep"])
    expect(report.skipped).toEqual([{ id: "nope", reason: "not-found" }])
    expect(tools.get("read")?.options?.codemode).toBe(true)
  })

  test("never adds a tool to satisfy a requested-but-absent id", () => {
    const { editor, calls, tools } = fakeEditor([])
    const report = enableBuiltinsForCodeMode(editor, { enabled: true, ids: ["read"] })
    expect(report.flipped).toEqual([])
    expect(report.skipped).toEqual([{ id: "read", reason: "not-found" }])
    expect(calls.add).toEqual([])
    expect(tools.size).toBe(0)
  })

  test("control-plane ids are always skipped with reason 'control-plane'", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    const report = enableBuiltinsForCodeMode(editor, { enabled: true, ids: [...NEVER_FLIP_IDS] })
    expect(report.flipped).toEqual([])
    expect(report.already).toEqual([])
    expect(report.skipped).toEqual(NEVER_FLIP_IDS.map((id) => ({ id, reason: "control-plane" })))
    expect(calls.update).toEqual([])
  })

  test("control-plane wins even when the id is absent and even if mixed with flippable ids", () => {
    const { editor } = fakeEditor([{ id: "read", name: "read", options: { codemode: false } }])
    const report = enableBuiltinsForCodeMode(editor, { enabled: true, ids: ["lsp", "read"] })
    expect(report.skipped).toEqual([{ id: "lsp", reason: "control-plane" }])
    expect(report.flipped).toEqual(["read"])
  })

  test("idempotent: second call reports already and does not re-update", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    const first = enableBuiltinsForCodeMode(editor, { enabled: true })
    expect(first.flipped.sort()).toEqual([...ALL].sort())
    const updatesAfterFirst = calls.update.length
    expect(updatesAfterFirst).toBe(ALL.length)

    const second = enableBuiltinsForCodeMode(editor, { enabled: true })
    expect(second.flipped).toEqual([])
    expect(second.already.sort()).toEqual([...ALL].sort())
    expect(second.skipped).toEqual([])
    expect(calls.update.length).toBe(updatesAfterFirst)
  })

  test("options merge preserves unrelated keys and other option keys", () => {
    const { editor, tools } = fakeEditor([
      { id: "read", name: "read", options: { codemode: false, namespace: "fs", pinned: false, custom: 1 } },
      { id: "shell", name: "shell", options: null },
    ])
    const report = enableBuiltinsForCodeMode(editor, { enabled: true, ids: ["read", "shell"] })
    expect(report.flipped).toEqual(["read", "shell"])

    expect(tools.get("read")?.name).toBe("read")
    expect(tools.get("read")?.options).toEqual({
      codemode: true,
      namespace: "fs",
      pinned: false,
      custom: 1,
    })
    // A null/absent options object still gains codemode without other keys.
    expect(tools.get("shell")?.name).toBe("shell")
    expect(tools.get("shell")?.options).toEqual({ codemode: true })
  })

  test("options object is copied, not mutated in place", () => {
    const original = { codemode: false, namespace: "fs" as unknown }
    const { editor, tools } = fakeEditor([{ id: "read", name: "read", options: original }])
    enableBuiltinsForCodeMode(editor, { enabled: true, ids: ["read"] })
    expect(tools.get("read")?.options).not.toBe(original)
    expect(original.codemode).toBe(false)
    expect(tools.get("read")?.options?.codemode).toBe(true)
  })

  test("never calls add or remove", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    enableBuiltinsForCodeMode(editor, { enabled: true, ids: [...ALL, ...NEVER_FLIP_IDS, "nope"] })
    expect(calls.add).toEqual([])
    expect(calls.remove).toEqual([])
  })

  test("reads the catalog once per call", () => {
    const { editor, calls } = fakeEditor(withBuiltins(false))
    enableBuiltinsForCodeMode(editor, { enabled: true })
    expect(calls.list).toBe(1)
  })
})

describe("constants", () => {
  test("BUILTIN_FILE_SHELL_IDS is the frozen six", () => {
    expect([...BUILTIN_FILE_SHELL_IDS]).toEqual(["read", "grep", "glob", "shell", "edit", "write"])
  })

  test("NEVER_FLIP_IDS is the frozen control-plane seven", () => {
    expect([...NEVER_FLIP_IDS]).toEqual(["question", "task", "skill", "todo", "plan", "lsp", "execute"])
  })

  test("no id appears on both lists", () => {
    const builtins = new Set<string>(BUILTIN_FILE_SHELL_IDS)
    for (const id of NEVER_FLIP_IDS) expect(builtins.has(id)).toBe(false)
  })
})
