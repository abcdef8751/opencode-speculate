// Deterministic check for the `buggy-stats` fixture. Exit 0 == pass.
import { mean, median } from "./src/stats.mjs";
import { summarize } from "./src/report.mjs";

const failures = [];
const eq = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
};

eq("mean([1,2,3])", mean([1, 2, 3]), 2);
eq("mean([2,4])", mean([2, 4]), 3);
eq("mean([])", mean([]), 0);
eq("median([1,2,3,4])", median([1, 2, 3, 4]), 2.5);
eq("median([5,1,3])", median([5, 1, 3]), 3);
eq("summarize([1,2,3]).mean", summarize([1, 2, 3]).mean, 2);

if (failures.length > 0) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log("buggy-stats: all checks passed");
