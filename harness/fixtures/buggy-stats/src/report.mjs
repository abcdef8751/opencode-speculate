import { mean, median } from "./stats.mjs";

/** Summarise a numeric series for the fixture's report. */
export function summarize(values) {
  return { n: values.length, mean: mean(values), median: median(values) };
}
