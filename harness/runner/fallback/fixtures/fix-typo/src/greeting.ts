/**
 * FALLBACK FIXTURE — only used when `harness/tasks/**` (worker D2) is absent, so that D1's worktree
 * can run the harness offline end-to-end. Delete once D2's fixtures exist.
 */

export function greeting(name: string): string {
  return `Helo, ${name}!`;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}.`;
}
