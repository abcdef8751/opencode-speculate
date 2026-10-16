// Deterministic integrity check for the `rename-corpus` fixture. Exit 0 == pass.
import { total, describe } from "./pkg/index.mjs";
import { legacyNote } from "./pkg/notes.mjs";

const failures = [];
const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  .map((n) => n * 2 + 1)
  .reduce((a, b) => a + b, 0);

if (total !== expected) failures.push(`total: expected ${expected}, got ${total}`);
if (!describe().includes("total=")) failures.push("describe() lost its label");
if (legacyNote !== "the legacy rate of return was recomputed") {
  failures.push("legacyNote prose was modified");
}

if (failures.length > 0) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log("rename-corpus: integrity ok");
