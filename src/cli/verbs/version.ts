import { maybePrintVerbHelp } from '../help.js';
import { readPackageVersion } from '../../tool-identifier.js';

/** Injectable terminal seam so version's single completion line is handler-testable. */
export interface VersionRunDeps {
  log?: (line: string) => void;
}

export function runVersion(argv: string[], deps: VersionRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'version', deps.log)) return;
  (deps.log ?? ((line: string) => console.log(line)))(readPackageVersion());
}
