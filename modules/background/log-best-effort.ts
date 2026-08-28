/**
 * Runs `fn` and swallows a failure into a single log line instead of letting
 * it interrupt the caller. `label` should already read as a complete clause
 * (e.g. "metadata write failed for task abc123") since it is logged verbatim.
 */
export async function logBestEffort(
  logger: Pick<Console, "error">,
  label: string,
  fn: () => unknown,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(`[jpi-background] ${label}:`, error);
  }
}
