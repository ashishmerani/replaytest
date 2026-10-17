/**
 * Provider-neutral evidence for a login-shaped journey.
 *
 * This is deliberately a narrow, structural signal rather than a claim that
 * an app requires authentication: a password input on a submitted form that
 * then navigates to another path. The CLI uses it only to add optional
 * hand-off guidance to sidecars from this same session.
 */

import type { NeutralStep, NeutralTarget } from './neutral-session.js';
import type { Journey } from './journeys.js';
import { extractPathname } from './canonical-url.js';

export interface WitnessedLogin {
  /** Path where the password-form interaction was witnessed. */
  loginPath: string;
  /** Zero-based index into the supplied session's journeys. */
  loginJourneyIndex: number;
}

/**
 * Returns the first journey with a witnessed password-form submit followed by
 * a navigation to another path. A password field without either the matching
 * submit or a post-submit path change remains unclassified.
 */
export function findWitnessedLogin(journeys: Journey[]): WitnessedLogin | undefined {
  for (const [loginJourneyIndex, journey] of journeys.entries()) {
    const loginPath = witnessedLoginPath(journey.steps);
    if (loginPath !== undefined) return { loginPath, loginJourneyIndex };
  }
  return undefined;
}

function witnessedLoginPath(steps: NeutralStep[]): string | undefined {
  for (let passwordIndex = 0; passwordIndex < steps.length; passwordIndex++) {
    const passwordStep = steps[passwordIndex];
    if (!isPasswordInput(passwordStep)) continue;

    for (let submitIndex = 0; submitIndex < steps.length; submitIndex++) {
      const submitStep = steps[submitIndex];
      if (submitStep.kind !== 'submit' || !sharesFormOrRoute(passwordStep, submitStep)) continue;

      if (steps.slice(submitIndex + 1).some((step) => step.kind === 'navigation' && !samePath(step.url, submitStep.url))) {
        return extractPathname(passwordStep.url, 'strip-query-and-fragment');
      }
    }
  }
  return undefined;
}

function isPasswordInput(step: NeutralStep): boolean {
  return step.kind === 'input' && step.target?.attributes?.type === 'password';
}

/**
 * The neutral interaction data normally preserves a nearest form ancestor.
 * Some otherwise usable recordings do not retain that structural identity;
 * in that case, matching the form route is the narrowest available fallback.
 */
function sharesFormOrRoute(input: NeutralStep, submit: NeutralStep): boolean {
  const inputForm = formIdentity(input.target);
  const submitForm = formIdentity(submit.target);
  if (inputForm !== undefined && submitForm !== undefined) return inputForm === submitForm;
  return samePath(input.url, submit.url);
}

function formIdentity(target: NeutralTarget | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (target.tag === 'form') return identityForForm(target);
  const form = target.ancestors?.find((ancestor) => ancestor.tag === 'form');
  return form === undefined ? undefined : identityForForm(form);
}

function identityForForm(form: { id?: string; nthChild?: number }): string | undefined {
  if (form.id !== undefined) return `id:${form.id}`;
  if (form.nthChild !== undefined) return `nth-child:${form.nthChild}`;
  return undefined;
}

function samePath(left: string, right: string): boolean {
  return extractPathname(left, 'strip-query-and-fragment') === extractPathname(right, 'strip-query-and-fragment');
}
