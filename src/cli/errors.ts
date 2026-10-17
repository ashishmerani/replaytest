

// ---------------------------------------------------------------------------
/** The clear command-boundary refusal for malformed project URL semantics. */
export function buildWizardStepConfigRefusal(error: string): string {
  return `Wizard-step config refused — ${error} Fix .replaytest/config.json and try again.`;
}

/** Extracts a human-readable message from a caught value of unknown shape (mirrors the inline `err instanceof Error ? err.message : String(err)` pattern already used elsewhere in this file). */
export function describeIoError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

