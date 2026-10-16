import { legacyRate } from "./core.mjs";
import { value01 } from "./node01.mjs";
import { value02 } from "./node02.mjs";
import { value03 } from "./node03.mjs";
import { value04 } from "./node04.mjs";
import { value05 } from "./node05.mjs";
import { value06 } from "./node06.mjs";
import { value07 } from "./node07.mjs";
import { value08 } from "./node08.mjs";
import { value09 } from "./node09.mjs";
import { value10 } from "./node10.mjs";

export const total =
  value01 + value02 + value03 + value04 + value05 +
  value06 + value07 + value08 + value09 + value10;

export function describe() {
  return `package total=${total}`;
}

export { legacyRate };
