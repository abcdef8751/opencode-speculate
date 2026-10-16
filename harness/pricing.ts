/**
 * Model pricing for the harness.
 *
 * Policy: a model id either has a *known* published price here or it does not. `priceFor` returns
 * `undefined` for anything unknown — the harness never guesses a price, and an unknown model
 * simply leaves `TokenUsage.costUsd` undefined and the report shows `n/a`.
 *
 * OWNER: worker D1.
 */

import type { TokenUsage } from "./types.ts";

export interface ModelPrices {
  /** USD per 1M uncached input tokens. */
  inputPer1M: number;
  /** USD per 1M cache-read tokens. */
  cachedReadPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/**
 * Known prices only. `jev-1.13-free` is free per `docs/CONTRACTS.md`
 * ("Model `jev-1.13-free` is free"), so its three prices are 0 — that is a measured fact, not a
 * guess. Add entries only with a citeable source; never approximate.
 */
export const PRICES: Readonly<Record<string, ModelPrices>> = Object.freeze({
  "jev-1.13-free": { inputPer1M: 0, cachedReadPer1M: 0, outputPer1M: 0 },
});

/** Prices for `modelId`, or `undefined` when the id is unknown/absent. Never guesses. */
export function priceFor(modelId: string | undefined, table: Readonly<Record<string, ModelPrices>> = PRICES): ModelPrices | undefined {
  if (modelId === undefined || modelId.length === 0) return undefined;
  const direct = table[modelId];
  if (direct !== undefined) return direct;
  // Accept "provider/model#variant" ids by matching the trailing "model" segment.
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const variant = bare.includes("#") ? bare.slice(0, bare.indexOf("#")) : bare;
  return table[variant] ?? table[bare];
}

/**
 * Cost of `usage` for `modelId`, or `undefined` when the model has no known price.
 *
 * Cache-write tokens are billed at the *input* price: the console endpoint reports a single input
 * price and no separate cache-write tariff, so anything else would be a guess. Documented in
 * `harness/README.md`.
 */
export function estimateCostUsd(
  usage: Pick<TokenUsage, "fresh" | "cacheWrite" | "cacheRead" | "output">,
  modelId: string | undefined,
  table?: Readonly<Record<string, ModelPrices>>,
): number | undefined {
  const prices = priceFor(modelId, table);
  if (prices === undefined) return undefined;
  const usd =
    ((usage.fresh + usage.cacheWrite) * prices.inputPer1M +
      usage.cacheRead * prices.cachedReadPer1M +
      usage.output * prices.outputPer1M) /
    1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

/** Adds two usage records (all fields summed; `costUsd` summed only when both sides have one). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const total: TokenUsage = {
    fresh: a.fresh + b.fresh,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
  if (a.costUsd !== undefined && b.costUsd !== undefined) total.costUsd = a.costUsd + b.costUsd;
  else if (a.costUsd !== undefined) total.costUsd = a.costUsd;
  else if (b.costUsd !== undefined) total.costUsd = b.costUsd;
  return total;
}

/** A zeroed usage record. */
export function zeroUsage(): TokenUsage {
  return { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}
