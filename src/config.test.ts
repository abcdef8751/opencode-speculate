import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type LoadConfigInput,
  loadConfig,
  parseBoolFlag,
  parseEnvFile,
  parseIdList,
} from "./config.ts"

/** Everything lives under one temp root; the real `~/.local/share/opencode/auth.json` is never read. */
const TMP = mkdtempSync(join(tmpdir(), "decide-config-test-"))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** The six built-ins from §2, inlined so this test does not import worker B's file. */
const DEFAULT_BUILTIN_IDS = ["read", "grep", "glob", "shell", "edit", "write"]

const NO_AUTH = join(TMP, "missing-auth.json")

function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function tmpDir(name: string): string {
  return mkdtempSync(join(TMP, `${name}-`))
}

/** Hermetic defaults: no env, temp dirs, an auth path that does not exist. */
function opts(over: Partial<LoadConfigInput> = {}): LoadConfigInput {
  return {
    env: {},
    directory: join(TMP, "project"),
    configDir: join(TMP, "config"),
    authJsonPath: NO_AUTH,
    ...over,
  }
}

function authJson(key: string): string {
  return JSON.stringify({ opencode: { type: "api", key } })
}

describe("parseEnvFile", () => {
  test("comments, blank lines, quotes, export prefix, inline comments", () => {
    const text = [
      "# leading comment",
      "",
      "   ",
      "OPENCODE_API_KEY=plain",
      "export TYPESAFE_API_KEY='single'",
      'DOUBLE="hello world"',
      "EMPTY=",
      "TRAILING=value # inline comment",
      "HASHY=abc#def",
      "  SPACED  =  trimmed  ",
      "NO_EQUALS_LINE",
      "=novalue",
      "export SPACED_EXPORT=  ok  ",
    ].join("\n")

    expect(parseEnvFile(text)).toEqual({
      OPENCODE_API_KEY: "plain",
      TYPESAFE_API_KEY: "single",
      DOUBLE: "hello world",
      EMPTY: "",
      TRAILING: "value",
      HASHY: "abc#def",
      SPACED: "trimmed",
      SPACED_EXPORT: "ok",
    })
  })

  test("CRLF, quoted-with-trailing-comment, later duplicates win", () => {
    const text = 'A="x y" # note\r\nA=second\r\nB=\'q\'\r\n'
    expect(parseEnvFile(text)).toEqual({ A: "second", B: "q" })
  })

  test("empty text → no keys", () => {
    expect(parseEnvFile("")).toEqual({})
  })
})

describe("parseBoolFlag / parseIdList", () => {
  test("boolean parsing is case-insensitive, garbage → undefined", () => {
    for (const yes of ["1", "true", "TRUE", "Yes", " on "]) {
      expect(parseBoolFlag(yes)).toBe(true)
    }
    for (const no of ["0", "false", "FALSE", "No", "off"]) {
      expect(parseBoolFlag(no)).toBe(false)
    }
    for (const garbage of ["", "  ", "maybe", "2", undefined]) {
      expect(parseBoolFlag(garbage)).toBeUndefined()
    }
  })

  test("comma list parsing", () => {
    expect(parseIdList("read,grep,glob")).toEqual(["read", "grep", "glob"])
    expect(parseIdList(" read , , grep ")).toEqual(["read", "grep"])
    expect(parseIdList("")).toBeUndefined()
    expect(parseIdList("  ")).toBeUndefined()
    expect(parseIdList(",")).toBeUndefined()
    expect(parseIdList(undefined)).toBeUndefined()
  })
})

describe("api key resolution order", () => {
  const SECRET = "sk-options"
  const ENV_KEY = "sk-env"
  const FILE_KEY = "sk-file"
  const AUTH_KEY = "sk-auth"

  test("overrides beat everything (apiKeySource: options)", () => {
    const envFile = writeFile(join(TMP, "ovr/.env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const authPath = writeFile(join(TMP, "ovr-auth.json"), authJson(AUTH_KEY))
    const config = loadConfig(
      opts({
        env: { OPENCODE_API_KEY: ENV_KEY, OPENCODE_DECIDE_ENV_FILE: envFile },
        authJsonPath: authPath,
        overrides: { apiKey: SECRET },
      }),
    )
    expect(config.apiKey).toBe(SECRET)
    expect(config.apiKeySource).toBe("options")
  })

  test("env beats env-file and auth.json", () => {
    const envFile = writeFile(join(TMP, "env/.env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const authPath = writeFile(join(TMP, "env-auth.json"), authJson(AUTH_KEY))
    const config = loadConfig(
      opts({
        env: { OPENCODE_API_KEY: ENV_KEY, OPENCODE_DECIDE_ENV_FILE: envFile },
        authJsonPath: authPath,
      }),
    )
    expect(config.apiKey).toBe(ENV_KEY)
    expect(config.apiKeySource).toBe("env")
  })

  test("LIQUID_AI_API_KEY wins, then LIQUID_API_KEY, then the legacy names", () => {
    expect(loadConfig(opts({ env: { LIQUID_AI_API_KEY: "sk-liquid" } })).apiKey).toBe("sk-liquid")
    expect(
      loadConfig(opts({ env: { LIQUID_API_KEY: "sk-liquid2", OPENCODE_API_KEY: "sk-old" } })).apiKey,
    ).toBe("sk-liquid2")
    expect(
      loadConfig(
        opts({ env: { LIQUID_AI_API_KEY: "sk-liquid1", LIQUID_API_KEY: "sk-liquid2" } }),
      ).apiKey,
    ).toBe("sk-liquid1")
    const config = loadConfig(opts({ env: {} }))
    expect(config.baseURL).toBe("https://api.liquid.ai/decisions")
    expect(config.model).toBe("d1-ultra")
  })

  test("TYPESAFE_API_KEY is the fallback env name; OPENCODE_API_KEY wins over it", () => {
    expect(loadConfig(opts({ env: { TYPESAFE_API_KEY: ENV_KEY } })).apiKeySource).toBe("env")
    const config = loadConfig(
      opts({ env: { OPENCODE_API_KEY: ENV_KEY, TYPESAFE_API_KEY: "sk-other" } }),
    )
    expect(config.apiKey).toBe(ENV_KEY)
  })

  test("explicit OPENCODE_DECIDE_ENV_FILE is read (apiKeySource: env-file)", () => {
    const envFile = writeFile(
      join(TMP, "file-explicit/custom.env"),
      `TYPESAFE_API_KEY='${FILE_KEY}'\n`,
    )
    const config = loadConfig(opts({ env: { OPENCODE_DECIDE_ENV_FILE: envFile } }))
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.apiKeySource).toBe("env-file")
    expect(config.envFile).toBe(envFile)
  })

  test("a project <directory>/.env alone is never read", () => {
    const project = tmpDir("project-dotenv")
    writeFile(join(project, ".env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig(opts({ directory: project }))
    expect(config.envFile).toBeUndefined()
    expect(config.apiKey).toBeUndefined()
    expect(config.apiKeySource).toBe("none")
  })

  test("<configDir>/.env is the only implicit env file", () => {
    const configDir = tmpDir("config-dotenv")
    const envFile = writeFile(join(configDir, ".env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig(opts({ configDir }))
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.apiKeySource).toBe("env-file")
    expect(config.envFile).toBe(envFile)
  })

  test("a project <directory>/.env is ignored and cannot shadow <configDir>/.env", () => {
    const project = tmpDir("shadow-project")
    writeFile(join(project, ".env"), "OPENCODE_API_KEY=sk-project\n")
    const configDir = tmpDir("shadow-config")
    const envFile = writeFile(join(configDir, ".env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig(opts({ directory: project, configDir }))
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.envFile).toBe(envFile)
  })

  test("OPENCODE_CONFIG_DIR selects the configDir default", () => {
    const configDir = tmpDir("config-env-dir")
    const envFile = writeFile(join(configDir, ".env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig({
      env: { OPENCODE_CONFIG_DIR: configDir },
      directory: join(TMP, "no-such-project"),
      authJsonPath: NO_AUTH,
    })
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.envFile).toBe(envFile)
  })

  test("a configured-but-missing env file falls through to <configDir>/.env", () => {
    const configDir = tmpDir("fallthrough-config")
    const envFile = writeFile(join(configDir, ".env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig(
      opts({
        configDir,
        env: { OPENCODE_DECIDE_ENV_FILE: join(TMP, "does-not-exist.env") },
      }),
    )
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.envFile).toBe(envFile)
  })

  test("empty env values count as absent, so the env file supplies the key", () => {
    const envFile = writeFile(join(TMP, "empty-env/.env"), `OPENCODE_API_KEY=${FILE_KEY}\n`)
    const config = loadConfig(
      opts({
        env: { OPENCODE_API_KEY: "", TYPESAFE_API_KEY: "  ", OPENCODE_DECIDE_ENV_FILE: envFile },
      }),
    )
    expect(config.apiKey).toBe(FILE_KEY)
    expect(config.apiKeySource).toBe("env-file")
  })
})

describe("auth.json fallback", () => {
  const AUTH_KEY = "sk-auth-json"

  test("default path `<configDir>/../.local/share/opencode/auth.json` is probed", () => {
    const configDir = join(tmpDir("auth-literal"), "opencode")
    const authPath = writeFile(
      join(configDir, "../.local/share/opencode/auth.json"),
      authJson(AUTH_KEY),
    )
    const config = loadConfig({
      env: {},
      directory: join(TMP, "no-such-project"),
      configDir,
    })
    expect(config.apiKey).toBe(AUTH_KEY)
    expect(config.apiKeySource).toBe("auth-json")
    expect(authPath).toBe(join(configDir, "../.local/share/opencode/auth.json"))
  })

  test("the real layout `<configDir>/../../.local/share/opencode/auth.json` works too", () => {
    const configDir = join(tmpDir("auth-real"), "config/opencode")
    writeFile(join(configDir, "../../.local/share/opencode/auth.json"), authJson(AUTH_KEY))
    const config = loadConfig({
      env: {},
      directory: join(TMP, "no-such-project"),
      configDir,
    })
    expect(config.apiKey).toBe(AUTH_KEY)
    expect(config.apiKeySource).toBe("auth-json")
  })

  test("explicit authJsonPath wins and the literal path is preferred when both exist", () => {
    const configDir = join(tmpDir("auth-both"), "opencode")
    writeFile(join(configDir, "../.local/share/opencode/auth.json"), authJson("sk-literal"))
    writeFile(join(configDir, "../../.local/share/opencode/auth.json"), authJson("sk-real"))
    const config = loadConfig({
      env: {},
      directory: join(TMP, "no-such-project"),
      configDir,
    })
    expect(config.apiKey).toBe("sk-literal")

    const explicit = writeFile(join(TMP, "explicit-auth.json"), authJson("sk-explicit"))
    expect(loadConfig(opts({ authJsonPath: explicit })).apiKey).toBe("sk-explicit")
  })

  test("missing auth.json → none, no throw", () => {
    const config = loadConfig(opts())
    expect(config.apiKey).toBeUndefined()
    expect(config.apiKeySource).toBe("none")
  })

  test("malformed auth.json → none, no throw", () => {
    const cases = [
      "not json at all",
      "",
      "[]",
      "null",
      '{"opencode":null}',
      "{}",
      '{"opencode":{}}',
      '{"opencode":{"key":123}}',
      '{"opencode":{"key":"  "}}',
    ]
    for (const [index, text] of cases.entries()) {
      const path = writeFile(join(TMP, `malformed-${index}.json`), text)
      const config = loadConfig(opts({ authJsonPath: path }))
      expect(config.apiKey).toBeUndefined()
      expect(config.apiKeySource).toBe("none")
    }
  })

  test("unreadable auth path (a directory) → none, no throw", () => {
    const dir = tmpDir("auth-is-a-dir")
    const config = loadConfig(opts({ authJsonPath: dir }))
    expect(config.apiKeySource).toBe("none")
  })

  test("OPENCODE_DECIDE_ALLOW_AUTH_JSON=0 disables the fallback", () => {
    const authPath = writeFile(join(TMP, "gated-auth.json"), authJson(AUTH_KEY))
    for (const disabled of ["0", "false", "FALSE", "no"]) {
      const config = loadConfig(
        opts({ env: { OPENCODE_DECIDE_ALLOW_AUTH_JSON: disabled }, authJsonPath: authPath }),
      )
      expect(config.apiKey).toBeUndefined()
      expect(config.apiKeySource).toBe("none")
    }
  })

  test("OPENCODE_DECIDE_ALLOW_AUTH_JSON=1 (and garbage) keeps the fallback", () => {
    const authPath = writeFile(join(TMP, "allowed-auth.json"), authJson(AUTH_KEY))
    for (const value of ["1", "true", "yes", "garbage", ""]) {
      const config = loadConfig(
        opts({ env: { OPENCODE_DECIDE_ALLOW_AUTH_JSON: value }, authJsonPath: authPath }),
      )
      expect(config.apiKey).toBe(AUTH_KEY)
      expect(config.apiKeySource).toBe("auth-json")
    }
  })

  test("the key only ever appears in `apiKey`", () => {
    const SECRET = "sk-only-in-apiKey"
    const config = loadConfig({
      env: { OPENCODE_API_KEY: SECRET },
      authJsonPath: NO_AUTH,
      overrides: {},
    })
    expect(config.apiKey).toBe(SECRET)
    for (const [field, value] of Object.entries(config)) {
      if (field === "apiKey") continue
      expect(String(JSON.stringify(value))).not.toContain(SECRET)
    }
    expect(JSON.stringify({ ...config, apiKey: undefined })).not.toContain(SECRET)
  })
})

describe("other keys and defaults", () => {
  test("defaults", () => {
    const config = loadConfig(opts())
    expect(config).toEqual({
      apiKey: undefined,
      apiKeySource: "none",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      builtinsCodemode: false,
      builtinIds: DEFAULT_BUILTIN_IDS,
      envFile: undefined,
      hintEnabled: true,
    })
  })

  test("baseURL / model come from env, then the env file, then defaults", () => {
    const envFile = writeFile(
      join(TMP, "other-keys/.env"),
      "OPENCODE_DECIDE_BASE_URL=https://file.example/systemone\nOPENCODE_DECIDE_MODEL=file-model\n",
    )
    const fromFile = loadConfig(opts({ env: { OPENCODE_DECIDE_ENV_FILE: envFile } }))
    expect(fromFile.baseURL).toBe("https://file.example/systemone")
    expect(fromFile.model).toBe("file-model")

    const fromEnv = loadConfig(
      opts({
        env: {
          OPENCODE_DECIDE_ENV_FILE: envFile,
          OPENCODE_DECIDE_BASE_URL: "https://env.example/systemone",
          OPENCODE_DECIDE_MODEL: "env-model",
        },
      }),
    )
    expect(fromEnv.baseURL).toBe("https://env.example/systemone")
    expect(fromEnv.model).toBe("env-model")

    const empty = loadConfig(
      opts({ env: { OPENCODE_DECIDE_BASE_URL: " ", OPENCODE_DECIDE_MODEL: "" } }),
    )
    expect(empty.baseURL).toBe(DEFAULT_BASE_URL)
    expect(empty.model).toBe(DEFAULT_MODEL)
  })

  test("builtinsCodemode parses 1/true/yes and defaults false", () => {
    for (const truthy of ["1", "true", "TRUE", "Yes"]) {
      expect(
        loadConfig(opts({ env: { OPENCODE_DECIDE_BUILTINS_CODEMODE: truthy } })).builtinsCodemode,
      ).toBe(true)
    }
    for (const falsy of ["0", "false", "garbage", ""]) {
      expect(
        loadConfig(opts({ env: { OPENCODE_DECIDE_BUILTINS_CODEMODE: falsy } })).builtinsCodemode,
      ).toBe(false)
    }
    expect(loadConfig(opts()).builtinsCodemode).toBe(false)
  })

  test("builtinIds parses a comma list and defaults to the six file/shell built-ins", () => {
    expect(loadConfig(opts()).builtinIds).toEqual(DEFAULT_BUILTIN_IDS)
    expect(
      loadConfig(opts({ env: { OPENCODE_DECIDE_BUILTIN_IDS: " read ,grep, , shell " } }))
        .builtinIds,
    ).toEqual(["read", "grep", "shell"])
    expect(
      loadConfig(opts({ env: { OPENCODE_DECIDE_BUILTIN_IDS: "read" } })).builtinIds,
    ).toEqual(["read"])
    expect(loadConfig(opts({ env: { OPENCODE_DECIDE_BUILTIN_IDS: "" } })).builtinIds).toEqual(
      DEFAULT_BUILTIN_IDS,
    )
    // fresh array each call — callers may mutate it
    expect(loadConfig(opts()).builtinIds).not.toBe(loadConfig(opts()).builtinIds)
  })

  test("hintEnabled defaults true and is disabled by 0/false", () => {
    expect(loadConfig(opts()).hintEnabled).toBe(true)
    for (const disabled of ["0", "false", "FALSE", "no"]) {
      expect(loadConfig(opts({ env: { OPENCODE_DECIDE_HINT: disabled } })).hintEnabled).toBe(false)
    }
    for (const enabled of ["1", "true", "yes", "garbage", ""]) {
      expect(loadConfig(opts({ env: { OPENCODE_DECIDE_HINT: enabled } })).hintEnabled).toBe(true)
    }
  })

  test("env-file values can carry the flags too", () => {
    const envFile = writeFile(
      join(TMP, "flag-file/.env"),
      "OPENCODE_DECIDE_HINT=0\nOPENCODE_DECIDE_BUILTINS_CODEMODE=yes\nOPENCODE_DECIDE_BUILTIN_IDS=read,grep\n",
    )
    const config = loadConfig(opts({ env: { OPENCODE_DECIDE_ENV_FILE: envFile } }))
    expect(config.hintEnabled).toBe(false)
    expect(config.builtinsCodemode).toBe(true)
    expect(config.builtinIds).toEqual(["read", "grep"])
  })

  test("overrides win for the non-key fields", () => {
    const config = loadConfig(
      opts({
        env: {
          OPENCODE_DECIDE_BASE_URL: "https://env.example",
          OPENCODE_DECIDE_MODEL: "env-model",
          OPENCODE_DECIDE_BUILTINS_CODEMODE: "1",
          OPENCODE_DECIDE_BUILTIN_IDS: "grep",
          OPENCODE_DECIDE_HINT: "1",
        },
        overrides: {
          baseURL: "https://override.example",
          model: "override-model",
          builtinsCodemode: false,
          builtinIds: ["read"],
          hintEnabled: false,
        },
      }),
    )
    expect(config.baseURL).toBe("https://override.example")
    expect(config.model).toBe("override-model")
    expect(config.builtinsCodemode).toBe(false)
    expect(config.builtinIds).toEqual(["read"])
    expect(config.hintEnabled).toBe(false)
  })

  test("loadConfig never throws for odd inputs and always returns the full shape", () => {
    const weird = [
      opts({ directory: "/definitely/does/not/exist", configDir: "/also/missing" }),
      opts({ env: { OPENCODE_DECIDE_ENV_FILE: "" } }),
      opts({ env: { OPENCODE_DECIDE_BUILTIN_IDS: ",,," } }),
      opts({ env: { OPENCODE_DECIDE_ALLOW_AUTH_JSON: "0" } }),
    ]
    for (const input of weird) {
      const config = loadConfig(input)
      expect(Object.keys(config).sort()).toEqual(
        [
          "apiKey",
          "apiKeySource",
          "baseURL",
          "builtinIds",
          "builtinsCodemode",
          "envFile",
          "hintEnabled",
          "model",
        ].sort(),
      )
      expect(["env", "env-file", "auth-json", "options", "none"]).toContain(config.apiKeySource)
    }
  })
})
