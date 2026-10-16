/**
 * In-memory `StoragePort` for one arm-C run.
 *
 * Per-run, deliberately: the decide cache must not leak between runs or arms, or a "cached"
 * verdict from an earlier run would distort latency and escalation metrics.
 *
 * OWNER: worker D1.
 */

import type { Json } from "../types.ts";
import type { StoragePort } from "../sandbox/decide-port.ts";

export interface MemoryStorage extends StoragePort {
  readonly entries: ReadonlyMap<string, Json>;
  readonly writes: number;
  readonly reads: number;
}

export function createMemoryStorage(seed?: Readonly<Record<string, Json>>): MemoryStorage {
  const store = new Map<string, Json>(seed === undefined ? [] : Object.entries(seed));
  let writes = 0;
  let reads = 0;
  return {
    get entries() {
      return store;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    async get(key: string): Promise<Json | undefined> {
      reads += 1;
      return store.get(key);
    },
    async set(key: string, value: Json): Promise<void> {
      writes += 1;
      store.set(key, value);
    },
  };
}
