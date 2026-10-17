/**
 * Marks an error whose message is safe and actionable for normal command-line
 * output. The entry point renders these without a stack unless the customer
 * explicitly asks for verbose diagnostics.
 */
export class ReplaytestUserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
