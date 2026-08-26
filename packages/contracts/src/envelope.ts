/**
 * The result envelope and the error taxonomy. Build plan §8.
 *
 * Business logic returns `ToolResult<T>`. The WebMCP adapter alone decides how that is encoded for
 * a particular runtime, so a change in how a browser wants results shaped touches one file rather
 * than nine tool handlers.
 */

export const ERROR_CODES = [
  'INVALID_INPUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CONTRACT_VIOLATION',
  'NO_MATCH',
  'MATCH_NOT_FOUND',
  'HOLD_CONFLICT',
  'HOLD_EXPIRED',
  'HOLD_NOT_FOUND',
  'CONSENT_CANCELLED',
  'EXECUTION_ABORTED',
  'REFERRAL_REJECTED',
  'STATE_CONFLICT',
  'PLAN_INFEASIBLE',
  'PLAN_NOT_FOUND',
  'LINK_VIOLATION',
  'LEASE_ORCHESTRATION_FAILED',
  'COMPENSATION_INCOMPLETE',
  'FEDERATION_UNAVAILABLE',
  'NOT_HOLDABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ToolSuccess<T> = {
  ok: true;
  data: T;
};

export type ToolFailure<D = unknown> = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
  /** Structured detail an agent can act on. Present on orchestration failures. */
  data?: D;
};

export type ToolResult<T, D = unknown> = ToolSuccess<T> | ToolFailure<D>;

export function ok<T>(data: T): ToolSuccess<T> {
  return { ok: true, data };
}

export function fail<D = unknown>(
  code: ErrorCode,
  message: string,
  options: { retryable?: boolean; data?: D } = {},
): ToolFailure<D> {
  const failure: ToolFailure<D> = {
    ok: false,
    error: { code, message, retryable: options.retryable ?? DEFAULT_RETRYABLE[code] },
  };
  if (options.data !== undefined) failure.data = options.data;
  return failure;
}

/**
 * Whether an agent retrying this error unchanged could plausibly succeed.
 *
 * Getting this wrong in either direction is a real failure mode. A `false` on something transient
 * makes an agent give up on a person's behalf; a `true` on something structural makes it hammer an
 * organisation that already said no.
 */
const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  INVALID_INPUT: false,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_CONTRACT_VIOLATION: false,
  NO_MATCH: false,
  MATCH_NOT_FOUND: false,
  HOLD_CONFLICT: true,
  HOLD_EXPIRED: true,
  HOLD_NOT_FOUND: false,
  CONSENT_CANCELLED: false,
  EXECUTION_ABORTED: false,
  REFERRAL_REJECTED: false,
  STATE_CONFLICT: false,
  PLAN_INFEASIBLE: false,
  PLAN_NOT_FOUND: false,
  LINK_VIOLATION: false,
  LEASE_ORCHESTRATION_FAILED: true,
  COMPENSATION_INCOMPLETE: true,
  FEDERATION_UNAVAILABLE: true,
  NOT_HOLDABLE: false,
  INTERNAL_ERROR: true,
};

/**
 * What a person is told, and what to do about it. Build plan §22.4.
 *
 * Every message names a next step. "Something went wrong" is not in this table, because a person
 * at 11pm arranging care for their mother needs to know what to do, not what happened.
 */
export const USER_FACING_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  INVALID_INPUT: 'That request was not in a form Threshold could use. Try describing the need again.',
  PROVIDER_UNAVAILABLE:
    'One organisation did not answer. The others were still checked, so the results below are incomplete rather than wrong.',
  PROVIDER_CONTRACT_VIOLATION:
    'One organisation returned data Threshold could not safely use, so it was left out. The others were still checked.',
  NO_MATCH: 'Nothing available matches all of these requirements. Relaxing one may open something up.',
  MATCH_NOT_FOUND: 'That option is no longer in the current results. Search again to see what is available now.',
  HOLD_CONFLICT:
    'That place was just taken by someone else. Choose another option, or search again to see what is left.',
  HOLD_EXPIRED: 'The hold ran out before the referral was sent. Search again to confirm it is still free.',
  HOLD_NOT_FOUND: 'That hold no longer exists. Search again to see current availability.',
  CONSENT_CANCELLED: 'Nothing was sent. The details are still here if you want to send them.',
  EXECUTION_ABORTED: 'That was cancelled before anything was sent.',
  REFERRAL_REJECTED:
    'The organisation could not accept the referral. The hold has been released so nobody else is blocked.',
  STATE_CONFLICT: 'That step is not available yet. The panel on the page shows where you are.',
  PLAN_INFEASIBLE: 'These parts do not fit together. The failing link is named below.',
  PLAN_NOT_FOUND: 'That plan is no longer current. Compose it again from the results.',
  LINK_VIOLATION: 'Two parts of this plan do not fit each other. The one to change is named below.',
  LEASE_ORCHESTRATION_FAILED:
    'One part of the plan could not be held, so everything else has been released. Nothing is reserved.',
  COMPENSATION_INCOMPLETE:
    'One organisation could not be reached to release a hold. It will lapse on its own within twenty minutes.',
  FEDERATION_UNAVAILABLE:
    'This browser cannot reach the provider organisations. Threshold needs WebMCP, or its fallback, to work.',
  NOT_HOLDABLE:
    'This entry comes from a public directory and is here for information only. Threshold does not place holds against real organisations.',
  INTERNAL_ERROR: 'Something in Threshold failed. Reload the page; nothing was sent.',
};
