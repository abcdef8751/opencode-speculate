/**
 * Event bus.
 */
export function emit(name, payload) {
  return { name, payload };
}
