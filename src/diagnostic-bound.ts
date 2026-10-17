/**
 * Bounded diagnostic projections for third-party tool output.
 *
 * This is the only constructor that lets raw diagnostic text become retained
 * or relayed pipeline data. It deliberately preserves case and line breaks;
 * classification may normalize its own copy, but a displayed diagnostic must
 * remain recognizable to the operator. Locator extraction happens before the
 * text bound so selector repair never loses the one actionable locator buried
 * in a large Playwright message.
 */

import { extractFailingLocator } from './triage-evidence.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND } from './cli/constants.js';

export const MAX_ENVIRONMENT_ERROR_CHARS = 4_000;

/** Customer-visible diagnostic elision marker. */
export const DIAGNOSTIC_ELISION_MARKER = '[diagnostic elided; the complete diagnostic is available at';

export type DiagnosticKind = 'playwright' | 'provider-cli' | 'dashboard-child';

export interface DiagnosticSourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface NormalizeDiagnosticInput {
  kind: DiagnosticKind;
  mode: string;
  message?: string;
  snippet?: string;
  /** Additional reporter error messages, each bounded independently. */
  errors?: string[];
  exitStatus?: number;
  sourceLocation?: DiagnosticSourceLocation;
  /** Resolved path to the customer-owned source report, when one exists. */
  pointer?: string;
}

export interface NormalizedDiagnostic {
  kind: DiagnosticKind;
  mode: string;
  message?: string;
  snippet?: string;
  errors?: string[];
  exitStatus?: number;
  sourceLocation?: DiagnosticSourceLocation;
  /** Extracted from the unbounded source before message/snippet bounding. */
  failingLocator?: string;
  /** Pointer rendered in the elision marker when this diagnostic was bounded. */
  pointer?: string;
}

function elisionMarker(pointer: string | undefined): string {
  if (pointer === undefined) return `[diagnostic elided; produce it with \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`]`;
  return `${DIAGNOSTIC_ELISION_MARKER} ${pointer}]`;
}

/**
 * Head+tail bound. A short input is returned byte-for-byte. A long input keeps
 * both ends and inserts one explicit pointer marker; the result never exceeds
 * MAX_ENVIRONMENT_ERROR_CHARS, including the marker itself.
 */
function boundDiagnosticText(value: string, pointer: string | undefined): string {
  if (value.length <= MAX_ENVIRONMENT_ERROR_CHARS) return value;
  const marker = `\n${elisionMarker(pointer)}\n`;
  const available = Math.max(0, MAX_ENVIRONMENT_ERROR_CHARS - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${marker}${tailLength === 0 ? '' : value.slice(-tailLength)}`;
}

/**
 * Normalize one raw diagnostic carrier. Callers may retain only the returned
 * object; they must not keep the input text separately in a persisted model.
 */
export function normalizeDiagnostic(input: NormalizeDiagnosticInput): NormalizedDiagnostic {
  const failingLocator = extractFailingLocator(input.message, input.snippet);
  const message = input.message === undefined ? undefined : boundDiagnosticText(input.message, input.pointer);
  const snippet = input.snippet === undefined ? undefined : boundDiagnosticText(input.snippet, input.pointer);
  const errors = input.errors?.map((error) => boundDiagnosticText(error, input.pointer));
  return {
    kind: input.kind,
    mode: input.mode,
    ...(message === undefined ? {} : { message }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(errors === undefined || errors.length === 0 ? {} : { errors }),
    ...(input.exitStatus === undefined ? {} : { exitStatus: input.exitStatus }),
    ...(input.sourceLocation === undefined ? {} : { sourceLocation: input.sourceLocation }),
    ...(failingLocator === undefined ? {} : { failingLocator }),
    ...(input.pointer === undefined ? {} : { pointer: input.pointer }),
  };
}
