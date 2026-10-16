import { describe, expect, test } from "bun:test";
import { addUsage, estimateCostUsd, priceFor, zeroUsage } from "./pricing.ts";

describe("pricing", () => {
  test("unknown models have no price (never guessed)", () => {
    expect(priceFor("mock:small")).toBeUndefined();
    expect(priceFor("")).toBeUndefined();
    expect(priceFor(undefined)).toBeUndefined();
    expect(estimateCostUsd(zeroUsage(), "whatever")).toBeUndefined();
  });

  test("the free model is priced at zero, not unknown", () => {
    expect(priceFor("jev-1.13-free")).toEqual({ inputPer1M: 0, cachedReadPer1M: 0, outputPer1M: 0 });
    expect(estimateCostUsd({ fresh: 1000, cacheWrite: 0, cacheRead: 500, output: 10 }, "jev-1.13-free")).toBe(0);
  });

  test("provider/model#variant ids resolve to the bare model, and compute per-1M", () => {
    const table = { "test-model": { inputPer1M: 3, cachedReadPer1M: 0.3, outputPer1M: 15 } };
    expect(priceFor("provider/test-model#thinking", table)).toEqual(table["test-model"]!);
    expect(estimateCostUsd({ fresh: 1_000_000, cacheWrite: 0, cacheRead: 1_000_000, output: 1_000_000 }, "test-model", table)).toBeCloseTo(
      18.3,
      8,
    );
  });

  test("cache-write tokens are billed at the input price", () => {
    const table = { m: { inputPer1M: 2, cachedReadPer1M: 0.2, outputPer1M: 8 } };
    expect(estimateCostUsd({ fresh: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0 }, "m", table)).toBeCloseTo(2, 8);
  });
});

describe("usage arithmetic", () => {
  test("addUsage sums fields and keeps costUsd only when present", () => {
    const a = { fresh: 1, cacheWrite: 2, cacheRead: 3, output: 4, costUsd: 0.5 };
    const b = { fresh: 10, cacheWrite: 20, cacheRead: 30, output: 40 };
    expect(addUsage(a, b)).toEqual({ fresh: 11, cacheWrite: 22, cacheRead: 33, output: 44, costUsd: 0.5 });
    expect(addUsage(b, b).costUsd).toBeUndefined();
  });

  test("zeroUsage is zero", () => {
    expect(zeroUsage()).toEqual({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});
