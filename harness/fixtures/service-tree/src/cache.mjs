/**
 * In-memory cache.
 * @deprecated replaced by the shared cache service
 */
// TODO: remove the Map fallback
// TODO: emit eviction metrics
export function cacheGet(key) {
  return key;
}
