/**
 * Generates an identifier using the existing Itera OS algorithm.
 */

export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
