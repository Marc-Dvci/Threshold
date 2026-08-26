/**
 * Cross-provider plan composition. Build plan §42.
 *
 * This is the part that makes several organisations *necessary* rather than merely present. A
 * federated search returns several independent answers, and one vendor with three product
 * categories can do that. Composition asks whether several offers, held at organisations that
 * cannot see each other, satisfy *each other*. That had no mechanism before.
 *
 * Note on strings in this file: `required` and `offered` are unconstrained strings, and that does
 * not re-open the hole §46.1 closes. Those values are formatted by hub code from already-validated,
 * already-pattern-constrained provider fields. The rule is about provider -> hub output, where the
 * string would be attacker-controlled. `tests/security` scopes its check accordingly.
 */

import { LINK_KINDS, PLAN_PART_ROLES } from '../vocabulary';
import {
  instantSchema,
  intervalSchema,
  opaqueIdSchema,
  providerIdSchema,
  resourceIdSchema,
  serviceAreaSchema,
  supportKindSchema,
} from './common';
import { offerCapabilitiesSchema } from './provider';
import { needProfileSchema } from './need-profile';

export const planPartRoleSchema = {
  type: 'string',
  enum: PLAN_PART_ROLES,
} as const;

/**
 * A part of a plan, resolved from stored validated search results.
 *
 * A `PlanPart` is never built from what the agent sent. The agent names a `(provider_id,
 * resource_id)` pair; the hub resolves it against its own validated results and builds the part
 * from those. Same rule as `place_hold` (§9.3): an identifier from a model is a lookup key, never a
 * source of facts.
 */
export const planPartSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'provider_id', 'resource_id', 'support_kind', 'service_area', 'capabilities', 'window'],
  properties: {
    role: planPartRoleSchema,
    provider_id: providerIdSchema,
    resource_id: resourceIdSchema,
    support_kind: supportKindSchema,
    service_area: serviceAreaSchema,
    capabilities: offerCapabilitiesSchema,
    /** The interval this part occupies. Derived per role, so links compare like with like. */
    window: intervalSchema,
    /** Placement only: the admission window, whose `to` is the cut-off. */
    admission: intervalSchema,
    /** Transport only. */
    pickup_earliest: instantSchema,
    journey_minutes: { type: 'integer', minimum: 5, maximum: 240 },
    /** Transport only, derived: `pickup_earliest + journey_minutes`. */
    arrival: instantSchema,
  },
} as const;

/**
 * A link that holds. Reported as well as the failures, because "which of these actually fit" is
 * information the agent needs in order to explain a plan to a person.
 */
const linkOkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ok'],
  properties: {
    kind: { type: 'string', enum: LINK_KINDS },
    ok: { type: 'boolean', const: true },
    /** Which parts the link was evaluated over. Absent for whole-plan links. */
    from: resourceIdSchema,
    to: resourceIdSchema,
  },
} as const;

/**
 * A link that fails.
 *
 * `renegotiate_with` is the field that makes this useful to an agent rather than merely correct. A
 * failing link has two ends and only one of them is worth a conversation: telling the respite unit
 * that the van is slow achieves nothing.
 */
const linkFailedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ok', 'field', 'required', 'offered', 'renegotiate_with'],
  properties: {
    kind: { type: 'string', enum: LINK_KINDS },
    ok: { type: 'boolean', const: false },
    from: resourceIdSchema,
    to: resourceIdSchema,
    field: { type: 'string', maxLength: 40 },
    required: { type: 'string', maxLength: 40 },
    offered: { type: 'string', maxLength: 40 },
    renegotiate_with: providerIdSchema,
    /** True when relaxing or swapping this part could plausibly fix the link. */
    relaxable: { type: 'boolean' },
  },
} as const;

export const linkResultSchema = {
  type: 'object',
  oneOf: [linkOkSchema, linkFailedSchema],
} as const;

/**
 * A candidate plan.
 *
 * Carries the `need` it was composed against, rather than a copy of the one field a link happens to
 * want. That makes `checkPlan` a pure function of the plan alone: no ambient context, no second
 * argument that a caller can forget to keep in step, and a plan that can be logged, replayed and
 * re-checked without the search session that produced it.
 *
 * Internal only, so the size does not compete with the agent-facing output budget.
 */
export const composedPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'search_id', 'need', 'parts'],
  properties: {
    plan_id: opaqueIdSchema,
    search_id: opaqueIdSchema,
    need: needProfileSchema,
    parts: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: planPartSchema,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// check_plan
// ---------------------------------------------------------------------------

export const checkPlanInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['search_id', 'parts'],
  properties: {
    search_id: {
      ...opaqueIdSchema,
      description: 'The search_id returned by find_support.',
    },
    parts: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description:
        'The combination to check: one entry per role. Include every part the plan needs, not just the placement.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'provider_id', 'resource_id'],
        properties: {
          role: {
            ...planPartRoleSchema,
            description: 'placement, transport, or cover.',
          },
          provider_id: {
            ...providerIdSchema,
            description: 'The organisation offering this part, as returned by find_support.',
          },
          resource_id: {
            ...resourceIdSchema,
            description: 'The resource identifier as returned by find_support.',
          },
        },
      },
    },
  },
} as const;

export const checkPlanOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'feasible', 'links'],
  properties: {
    plan_id: opaqueIdSchema,
    feasible: { type: 'boolean' },
    links: { type: 'array', items: linkResultSchema, maxItems: 12 },
    /** Roles the plan is missing entirely, if any. */
    missing_roles: { type: 'array', items: planPartRoleSchema, maxItems: 3 },
  },
} as const;

// ---------------------------------------------------------------------------
// Leases over a whole plan
// ---------------------------------------------------------------------------

export const leaseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'provider_id', 'resource_id', 'hold_id', 'expires_at_epoch_ms'],
  properties: {
    role: planPartRoleSchema,
    provider_id: providerIdSchema,
    resource_id: resourceIdSchema,
    hold_id: opaqueIdSchema,
    expires_at_epoch_ms: { type: 'integer', minimum: 0 },
  },
} as const;

export const compensationEntrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider_id', 'resource_id', 'hold_id', 'status'],
  properties: {
    provider_id: providerIdSchema,
    resource_id: resourceIdSchema,
    hold_id: opaqueIdSchema,
    status: {
      type: 'string',
      enum: ['released', 'already_released', 'expired', 'unreachable'],
    },
  },
} as const;

export const placePlanHoldsInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id'],
  properties: {
    plan_id: {
      ...opaqueIdSchema,
      description: 'A plan_id from check_plan that came back feasible.',
    },
  },
} as const;

export const placePlanHoldsOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'leases', 'status'],
  properties: {
    plan_id: opaqueIdSchema,
    leases: { type: 'array', items: leaseSchema, maxItems: 4 },
    status: { type: 'string', const: 'all_held' },
  },
} as const;

/**
 * What comes back when orchestration fails part way.
 *
 * Deliberately not a partial success. Reporting "two of three held" would invite an agent to tell a
 * person something is reserved when the plan cannot happen. The failure carries the compensation
 * record so the agent can say truthfully that nothing is being held.
 */
export const orchestrationFailureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'failed_role', 'failed_reason', 'compensation'],
  properties: {
    plan_id: opaqueIdSchema,
    failed_role: planPartRoleSchema,
    failed_reason: {
      type: 'string',
      enum: ['HOLD_CONFLICT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CONTRACT_VIOLATION', 'EXECUTION_ABORTED'],
    },
    compensation: { type: 'array', items: compensationEntrySchema, maxItems: 4 },
    /** True when every lease the plan held is now provably gone. */
    compensation_complete: { type: 'boolean' },
  },
} as const;

export const releasePlanInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id'],
  properties: {
    plan_id: {
      ...opaqueIdSchema,
      description: 'The plan whose leases should all be released.',
    },
  },
} as const;

export const releasePlanOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'released', 'complete'],
  properties: {
    plan_id: opaqueIdSchema,
    released: { type: 'array', items: compensationEntrySchema, maxItems: 4 },
    complete: { type: 'boolean' },
  },
} as const;
