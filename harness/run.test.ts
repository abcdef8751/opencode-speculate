import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./run.ts";

describe("CLI argument parsing", () => {
  test("defaults", () => {
    const opts = parseCliArgs([]);
    expect(opts.list).toBe(false);
    expect(opts.tasks).toEqual([]);
    expect(opts.arms).toEqual(["A", "B", "C"]);
    expect(opts.runs).toBe(1);
    expect(opts.driver).toBe("mock");
    expect(opts.keepScratch).toBe(false);
  });

  test("parses the documented invocation", () => {
    const opts = parseCliArgs(["--tasks", "a,b", "--arms", "A,C", "--runs", "3", "--driver", "opencode"]);
    expect(opts.tasks).toEqual(["a", "b"]);
    expect(opts.arms).toEqual(["A", "C"]);
    expect(opts.runs).toBe(3);
    expect(opts.driver).toBe("opencode");
  });

  test("supports --flag=value and extra flags", () => {
    const opts = parseCliArgs(["--tasks=x", "--arms=b,c", "--runs=2", "--driver=mock", "--max-turns", "4", "--seed", "9", "--out", "tmp/out", "--keep-scratch"]);
    expect(opts.tasks).toEqual(["x"]);
    expect(opts.arms).toEqual(["B", "C"]);
    expect(opts.maxTurns).toBe(4);
    expect(opts.seed).toBe(9);
    expect(opts.out).toBe("tmp/out");
    expect(opts.keepScratch).toBe(true);
  });

  test("rejects bad input loudly", () => {
    expect(() => parseCliArgs(["--arms", "D"])).toThrow(/unknown arm "D"/);
    expect(() => parseCliArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseCliArgs(["--runs", "two"])).toThrow(/positive integer/);
    expect(() => parseCliArgs(["--driver", "gpt"])).toThrow(/unknown driver/);
    expect(() => parseCliArgs(["--tasks"])).toThrow(/missing value/);
    expect(() => parseCliArgs(["positional"])).toThrow(/unexpected argument/);
    expect(() => parseCliArgs(["--nope"])).toThrow(/unknown flag/);
  });

  test("--list does not require --tasks", () => {
    expect(parseCliArgs(["--list"]).list).toBe(true);
  });
});
