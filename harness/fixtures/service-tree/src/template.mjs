/**
 * String templating.
 */
export function template(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}
