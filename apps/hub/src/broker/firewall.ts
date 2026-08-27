/**
 * The typed trust firewall. Build plan §11.
 *
 * Every value that enters the hub from another origin passes through here, and nothing else does.
 * The rule the module exists to enforce is one sentence: **no provider result is trusted because it
 * came through WebMCP.** WebMCP decides who may call what. It says nothing whatsoever about whether
 * the bytes coming back are true, well formed, or safe to hand to a language model.
 *
 * The pipeline, in order, with no step optional and no step reorderable:
 *
 *     ExecuteOutcome  ->  raw string  ->  JSON.parse  ->  Ajv strict  ->  projection  ->  hub data
 *
 * Three properties are worth stating because each of them is a bug that would otherwise be found on
 * camera:
 *
 *  1. **`null` is not an empty success.** `executeTool` returns `null` when the call triggered a
 *     navigation. Read as "the provider answered with nothing", that silently deletes an
 *     organisation from a person's options. It is surfaced as its own outcome.
 *
 *  2. **A failure is a value, never a rejection.** One provider misbehaving must not be able to
 *     reject the fan-out it is part of (Invariant H). Every path through this module returns a
 *     discriminated result.
 *
 *  3. **A rejected payload is never carried forward.** Not into a return value, not into a log line,
 *     not into an exception message. The payload that failed validation is exactly the payload most
 *     likely to have been written by someone hostile, and an error string is a channel like any
 *     other (§11.3). Only the rule that rejected it and the offending field *name* survive.
 */

import {
  ContractError,
  V,
  type ProviderAvailability,
  type ProviderError,
  type ProviderHoldOutput,
  type ProviderReferralOutput,
  type ProviderReleaseOutput,
  type Validator,
} from '@threshold/contracts';
import type { ExecuteOutcome } from '@threshold/webmcp-adapter';

/**
 * What the hub learned from one call to one provider.
 *
 * `provider_error` is separate from `contract_error` on purpose. The first is an organisation
 * telling us, in the contract's own vocabulary, that it cannot do something. The second is an
 * organisation failing to speak the contract at all. Collapsing them would make "the bed is taken"
 * and "this provider is broken" the same sentence to a person, and they are not.
 */
export type FirewallResult<T> =
  | { state: 'ok'; value: T; ms: number }
  | { state: 'provider_error'; error: ProviderError; ms: number }
  | { state: 'contract_error'; summary: string; path: string; ms: number }
  | { state: 'timeout'; ms: number }
  | { state: 'unavailable'; reason: string; ms: number }
  | { state: 'aborted'; ms: number };

/**
 * Does this payload claim to be the provider's failure contract?
 *
 * Presence of `error_code` and nothing else. Deliberately not "does it fail the success schema,
 * therefore try the error schema": that would let a malformed success payload be re-read as an
 * error and reported to a person as though the organisation had said something it did not say.
 */
function looksLikeProviderError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'error_code')
  );
}

/**
 * Run one provider round trip through the firewall.
 *
 * The success validator is passed in rather than switched on here, so adding a fifth provider tool
 * means naming its contract at the call site rather than editing a switch in the security-critical
 * module.
 */
export function passThroughFirewall<T>(
  outcome: ExecuteOutcome,
  success: Validator<T>,
): FirewallResult<T> {
  const ms = outcome.ms;

  switch (outcome.state) {
    case 'timeout':
      return { state: 'timeout', ms };
    case 'aborted':
      return { state: 'aborted', ms };
    case 'failed':
      return { state: 'unavailable', reason: outcome.reason, ms };
    case 'navigated':
      // A navigation is a contract violation, not an empty answer. Named as such so the boundary
      // log says something true rather than "0 offers".
      return {
        state: 'contract_error',
        summary: 'the call triggered a navigation instead of returning a result',
        path: '',
        ms,
      };
    case 'ok':
      break;
  }

  if (outcome.raw.length > 64_000) {
    return { state: 'contract_error', summary: 'response was oversized', path: '', ms };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.raw);
  } catch {
    return { state: 'contract_error', summary: 'response was not valid JSON', path: '', ms };
  }

  if (looksLikeProviderError(parsed)) {
    const asError = V.providerError.tryParse(parsed);
    if (asError.ok) return { state: 'provider_error', error: asError.value, ms };
    return { state: 'contract_error', summary: asError.error.summary, path: firstPath(asError.error), ms };
  }

  const validated = success.tryParse(parsed);
  if (!validated.ok) {
    return {
      state: 'contract_error',
      summary: validated.error.summary,
      path: firstPath(validated.error),
      ms,
    };
  }

  return { state: 'ok', value: validated.value, ms };
}

function firstPath(error: ContractError): string {
  return error.violations[0]?.path ?? '';
}

// ---------------------------------------------------------------------------
// The four provider contracts, named once
// ---------------------------------------------------------------------------

export const availabilityFirewall = (o: ExecuteOutcome): FirewallResult<ProviderAvailability> =>
  passThroughFirewall(o, V.providerAvailability);

export const holdFirewall = (o: ExecuteOutcome): FirewallResult<ProviderHoldOutput> =>
  passThroughFirewall(o, V.providerHoldOutput);

export const releaseFirewall = (o: ExecuteOutcome): FirewallResult<ProviderReleaseOutput> =>
  passThroughFirewall(o, V.providerReleaseOutput);

export const referralFirewall = (o: ExecuteOutcome): FirewallResult<ProviderReferralOutput> =>
  passThroughFirewall(o, V.providerReferralOutput);
