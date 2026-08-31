// Duplicated from src/core/errors.ts: src/pi must never import src/core (see
// README.md), and this is small enough that duplicating it beats a shared
// dependency neither side should own.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
