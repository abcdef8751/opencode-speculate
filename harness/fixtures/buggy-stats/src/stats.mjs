// Small statistics helpers used by the fixture's check script.

export function mean(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  // BUG: divides by (length - 1) — a sample-size divisor — instead of length.
  return total / (values.length - 1);
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
