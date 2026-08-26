/**
 * The hub's agent-facing tool contracts. Build plan §9.
 *
 * Two budgets govern the shapes here, both from Chrome's guidance, and both are design constraints
 * rather than nits:
 *
 *  - tool description 500 chars, parameter description 150 chars. A truncated description is a
 *    mis-selected tool.
 *  - single tool output around 1.5K. This is why `find_support` returns identities and counts rather
 *    than every field of every offer, and why the reason a near-miss failed lives in `explain_gap`
 *    instead. Splitting the detail out is not an accident of the API: it means the agent pays for
 *    detail only on the one option it is actually considering.
 */

import {
  assertionClassSchema,
  instantSchema,
  intervalSchema,
  opaqueIdSchema,
  providerIdSchema,
  providerStatusSchema,
  resourceIdSchema,
  supportKindSchema,
} from './common.js';
import { needProfileSchema } from './need-profile.js';
import { planPartRoleSchema } from './composition.js';

// ---------------------------------------------------------------------------
// find_support
// ---------------------------------------------------------------------------

export const findSupportInputSchema = needProfileSchema;

/** One offer, as the agent sees it. Identity, timing, and whether it can be leased. */
const normalizedMatchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider_id', 'resource_id', 'role', 'support_kind', 'window', 'holdable', 'assertion_class'],
  properties: {
    provider_id: providerIdSchema,
    resource_id: resourceIdSchema,
    role: planPartRoleSchema,
    support_kind: supportKindSchema,
    window: intervalSchema,
    /** Placement only: `to` is the admission cut-off a transport leg has to beat. */
    admission: intervalSchema,
    /** Transport only, derived by the hub. */
    arrival: instantSchema,
    holdable: { type: 'boolean' },
    units_left: { type: 'integer', minimum: 0, maximum: 99 },
    /**
     * Whether this organisation asserted its own capabilities or a public directory records them.
     *
     * Offer-level rather than field-level: every field of one offer comes from one source, because
     * the hub never merges two sources into a single offer. If it ever did, this becomes a map.
     * §23.10, §44.5.
     */
    assertion_class: assertionClassSchema,
  },
} as const;

/**
 * A near miss carries identity and a count, not the reasons. `explain_gap` has the reasons. The
 * agent asks about the one or two it cares about instead of paying for all of them.
 */
const nearMissSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider_id', 'resource_id', 'role', 'failed_count'],
  properties: {
    provider_id: providerIdSchema,
    resource_id: resourceIdSchema,
    role: planPartRoleSchema,
    failed_count: { type: 'integer', minimum: 1, maximum: 12 },
    /** True when every failed requirement is one the person could plausibly relax. */
    relaxable: { type: 'boolean' },
  },
} as const;

export const findSupportOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['search_id', 'exact_matches', 'near_misses', 'providers_checked'],
  properties: {
    search_id: opaqueIdSchema,
    exact_matches: { type: 'array', items: normalizedMatchSchema, maxItems: 6 },
    near_misses: { type: 'array', items: nearMissSchema, maxItems: 4 },
    providers_checked: { type: 'array', items: providerStatusSchema, maxItems: 6 },
    /** Present when results were truncated to fit the output budget. */
    truncated: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exact_matches_total: { type: 'integer', minimum: 0 },
        near_misses_total: { type: 'integer', minimum: 0 },
      },
    },
    /** Roles the search found nothing at all for. Tells the agent a plan is not yet possible. */
    roles_with_no_offer: { type: 'array', items: planPartRoleSchema, maxItems: 3 },
  },
} as const;

// ---------------------------------------------------------------------------
// explain_gap
// ---------------------------------------------------------------------------

/**
 * Accepts either shape. One offer against one requirement set, or one whole plan.
 *
 * `oneOf` rather than two tools, because they answer the same question at two altitudes and a
 * nine-tool surface is already at the point where selection cost starts to matter.
 */
export const explainGapInputSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['search_id', 'match_id'],
      properties: {
        search_id: { ...opaqueIdSchema, description: 'The search_id from find_support.' },
        match_id: {
          ...resourceIdSchema,
          description: 'A resource_id from near_misses, to learn which requirements it failed.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['search_id', 'plan_id'],
      properties: {
        search_id: { ...opaqueIdSchema, description: 'The search_id from find_support.' },
        plan_id: {
          ...opaqueIdSchema,
          description: 'A plan_id from check_plan, to learn which links between organisations failed.',
        },
      },
    },
  ],
} as const;

const failedRequirementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'required', 'offered'],
  properties: {
    field: { type: 'string', maxLength: 40 },
    required: { type: 'string', maxLength: 40 },
    offered: { type: 'string', maxLength: 40 },
  },
} as const;

export const explainGapOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: { type: 'string', enum: ['match', 'plan'] },
    match_id: resourceIdSchema,
    plan_id: opaqueIdSchema,
    /** `scope: "match"`: which of the person's requirements this offer does not meet. */
    failed_requirements: { type: 'array', items: failedRequirementSchema, maxItems: 12 },
    /** `scope: "plan"`: which links between organisations fail, in evaluation order. */
    failed_links: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'field', 'required', 'offered', 'renegotiate_with'],
        properties: {
          kind: { type: 'string', maxLength: 40 },
          from: resourceIdSchema,
          to: resourceIdSchema,
          field: { type: 'string', maxLength: 40 },
          required: { type: 'string', maxLength: 40 },
          offered: { type: 'string', maxLength: 40 },
          renegotiate_with: providerIdSchema,
        },
      },
    },
    /**
     * Resources already in the validated search results that could fill the same role. Lets the
     * agent re-check a plan without a second fan-out, which is both faster and less traffic against
     * organisations that did nothing wrong.
     */
    alternatives_same_role: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['provider_id', 'resource_id', 'role'],
        properties: {
          provider_id: providerIdSchema,
          resource_id: resourceIdSchema,
          role: planPartRoleSchema,
        },
      },
    },
    relaxable: { type: 'boolean' },
  },
} as const;

// ---------------------------------------------------------------------------
// place_hold / release_hold (single resource)
// ---------------------------------------------------------------------------

export const placeHoldInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['search_id', 'match_id'],
  properties: {
    search_id: { ...opaqueIdSchema, description: 'The search_id from find_support.' },
    match_id: {
      ...resourceIdSchema,
      description: 'A resource_id from exact_matches whose holdable field is true.',
    },
  },
} as const;

export const placeHoldOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'resource_id', 'provider_id', 'expires_in_seconds'],
  properties: {
    hold_id: opaqueIdSchema,
    resource_id: resourceIdSchema,
    provider_id: providerIdSchema,
    /**
     * Relative, not absolute. The provider's clock is the authority (Invariant E) and a relative
     * figure is what an agent can actually use in a sentence to a person. The UI countdown is
     * rendered from the absolute provider value, which never leaves the hub.
     */
    expires_in_seconds: { type: 'integer', minimum: 0, maximum: 1200 },
  },
} as const;

export const releaseHoldInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id'],
  properties: {
    hold_id: { ...opaqueIdSchema, description: 'The hold_id returned by place_hold.' },
  },
} as const;

export const releaseHoldOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'status'],
  properties: {
    hold_id: opaqueIdSchema,
    status: { type: 'string', enum: ['released', 'already_released', 'expired', 'converted'] },
  },
} as const;

// ---------------------------------------------------------------------------
// make_referral
// ---------------------------------------------------------------------------

/**
 * The one tool whose execute() does not resolve on its own.
 *
 * Calling it opens a panel and returns a Promise that settles on a human action. The agent's call
 * is genuinely pending in the meantime, which is the whole mechanism: consent lives in the page,
 * with the page's framing, rather than in a host dialog that can only approve or refuse an opaque
 * call.
 *
 * No free-form notes field. A referral is a structured act.
 */
export const makeReferralInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'person_name', 'contact_method', 'contact_value', 'preferred_contact_window'],
  properties: {
    hold_id: {
      ...opaqueIdSchema,
      description: 'The hold_id of the lease this referral is against.',
    },
    person_name: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description:
        'The name to send. Proposed only: the person reviews and can change it before anything is sent.',
    },
    contact_method: {
      type: 'string',
      enum: ['phone', 'email'],
      description: 'How the organisation should make contact.',
    },
    contact_value: {
      type: 'string',
      minLength: 3,
      maxLength: 120,
      description: 'The phone number or email address. Proposed only; the person can change it.',
    },
    preferred_contact_window: {
      type: 'string',
      enum: ['now', 'morning', 'afternoon', 'evening'],
      description: 'When the person prefers to be contacted.',
    },
  },
} as const;

export const makeReferralOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['referral_id', 'provider_id', 'fields_sent', 'human_edited'],
  properties: {
    referral_id: opaqueIdSchema,
    provider_id: providerIdSchema,
    /** Which field *names* crossed the boundary. Never the values. */
    fields_sent: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'string',
        enum: ['person_name', 'contact_method', 'contact_value', 'preferred_contact_window'],
      },
    },
    /**
     * Which fields the person changed before sending.
     *
     * The agent needs this: if it proposed a phone number and the person corrected it, the agent is
     * now holding a stale value and should not repeat it back as fact.
     */
    human_edited: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'string',
        enum: ['person_name', 'contact_method', 'contact_value', 'preferred_contact_window'],
      },
    },
    next_step: {
      type: 'string',
      enum: ['provider_will_call', 'provider_will_email', 'arrive_at_stated_time'],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// get_plan
// ---------------------------------------------------------------------------

export const getPlanInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['referral_id'],
  properties: {
    referral_id: {
      ...opaqueIdSchema,
      description: 'The referral_id returned by make_referral.',
    },
  },
} as const;

export const getPlanOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['referral_id', 'status', 'parts'],
  properties: {
    referral_id: opaqueIdSchema,
    status: { type: 'string', enum: ['referred'] },
    parts: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'provider_id', 'resource_id', 'window'],
        properties: {
          role: planPartRoleSchema,
          provider_id: providerIdSchema,
          resource_id: resourceIdSchema,
          window: intervalSchema,
        },
      },
    },
    next_step: {
      type: 'string',
      enum: ['provider_will_call', 'provider_will_email', 'arrive_at_stated_time'],
    },
  },
} as const;
