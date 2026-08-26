/**
 * The provider contract: what crosses the cross-origin boundary, in both directions.
 *
 * This file is the trust boundary. Two rules govern everything in it:
 *
 *  1. `additionalProperties: false` at *every* object layer. Not just the top.
 *  2. No free-form string surface anywhere in provider -> hub output. Every field is an enum, a
 *     boolean, an integer, or a string under a pattern or a format. This is what makes the security
 *     claim in §46.1 a property of the schema rather than a promise: an instruction to a model does
 *     not fit in `^[A-Z]{1,3}[0-9]{1,4}$`, and it does not fit in an enum.
 *
 * Revision 1.0 left four free-form surfaces open here: `provider_id`, `resource_id`, `generated_at`
 * and `spoken_languages: string[]`. All four are closed. Adding a plain `{ type: 'string' }` to any
 * provider output schema re-opens the hole, so `tests/security` asserts that none exists.
 */

import {
  clockTimeSchema,
  generatedAtSchema,
  instantSchema,
  intervalSchema,
  opaqueIdSchema,
  providerIdSchema,
  resourceIdSchema,
  serviceAreaSchema,
  spokenLanguagesSchema,
  spokenLanguageSchema,
  supportKindSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Hub -> provider: the query
// ---------------------------------------------------------------------------

/**
 * What the hub sends a provider when searching.
 *
 * A *projection* of the need profile, not the whole thing (§10.2). A transport service has no
 * business knowing that the person needs dementia-trained staff, so it is not told. The projection
 * is computed per provider from its declared support kinds.
 */
export const providerQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['service_area', 'support_kinds', 'required_capabilities'],
  properties: {
    service_area: serviceAreaSchema,
    support_kinds: {
      type: 'array',
      items: supportKindSchema,
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    },
    /**
     * Only the capabilities this provider could possibly satisfy. A capability the provider does
     * not deal in is omitted rather than sent as `false`, because `false` still discloses that the
     * question was asked.
     */
    required_capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dementia_trained: { type: 'boolean' },
        wheelchair_access: { type: 'boolean' },
        hoist_available: { type: 'boolean' },
        same_gender_staff_available: { type: 'boolean' },
        accepts_pets: { type: 'boolean' },
        spoken_language: spokenLanguageSchema,
      },
    },
    /** Coarse window, so a provider can filter its own inventory before answering. */
    starts_within_hours: { type: 'integer', minimum: 1, maximum: 168 },
    min_duration_hours: { type: 'integer', minimum: 1, maximum: 168 },
  },
} as const;

// ---------------------------------------------------------------------------
// Provider -> hub: availability
// ---------------------------------------------------------------------------

/** The capability block every offer carries. All fields required: absence must not read as false. */
export const offerCapabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'dementia_trained',
    'wheelchair_access',
    'hoist_available',
    'same_gender_staff_available',
    'accepts_pets',
    'spoken_languages',
  ],
  properties: {
    dementia_trained: { type: 'boolean' },
    wheelchair_access: { type: 'boolean' },
    hoist_available: { type: 'boolean' },
    same_gender_staff_available: { type: 'boolean' },
    accepts_pets: { type: 'boolean' },
    spoken_languages: spokenLanguagesSchema,
  },
} as const;

const offerCommon = {
  resource_id: resourceIdSchema,
  service_area: serviceAreaSchema,
  capabilities: offerCapabilitiesSchema,
  /** False for anything sourced from a real public directory. Invariant K. */
  holdable: { type: 'boolean' },
  /** How many of this resource exist. 1 makes a resource scarce enough to contend for. */
  units: { type: 'integer', minimum: 0, maximum: 99 },
} as const;

/**
 * A placement offer. Carries the admission window, which is the field the film's failing link is
 * measured against: a bed that admits until 06:40 is not reachable by a van arriving at 07:10.
 */
export const placementOfferSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['support_kind', 'resource_id', 'service_area', 'capabilities', 'holdable', 'units', 'admission', 'stay'],
  properties: {
    ...offerCommon,
    support_kind: { type: 'string', const: 'respite_bed' },
    /** The window during which the person can be admitted. `to` is the cut-off. */
    admission: intervalSchema,
    /** The window the placement itself covers. */
    stay: intervalSchema,
  },
} as const;

/** A transport offer. Arrival is derived, never published: `pickup_earliest + journey_minutes`. */
export const transportOfferSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'support_kind',
    'resource_id',
    'service_area',
    'capabilities',
    'holdable',
    'units',
    'pickup_earliest',
    'pickup_latest',
    'journey_minutes',
  ],
  properties: {
    ...offerCommon,
    support_kind: { type: 'string', const: 'accessible_transport' },
    pickup_earliest: instantSchema,
    pickup_latest: instantSchema,
    journey_minutes: { type: 'integer', minimum: 5, maximum: 240 },
  },
} as const;

/** A cover offer: overnight care in the person's own home, before or after a placement. */
export const coverOfferSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['support_kind', 'resource_id', 'service_area', 'capabilities', 'holdable', 'units', 'window'],
  properties: {
    ...offerCommon,
    support_kind: { type: 'string', const: 'overnight_homecare' },
    window: intervalSchema,
  },
} as const;

/**
 * The provider availability result.
 *
 * `oneOf` with a `const` discriminator on `support_kind`, so the union is unambiguous and the
 * derived TypeScript type is a proper discriminated union rather than a bag of optional fields.
 */
export const providerAvailabilitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider_id', 'generated_at', 'offers'],
  properties: {
    provider_id: providerIdSchema,
    generated_at: generatedAtSchema,
    offers: {
      type: 'array',
      maxItems: 25,
      items: {
        oneOf: [placementOfferSchema, transportOfferSchema, coverOfferSchema],
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Provider -> hub: leases
// ---------------------------------------------------------------------------

export const providerHoldInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resource_id', 'requested_ttl_seconds', 'client_request_id'],
  properties: {
    resource_id: resourceIdSchema,
    /**
     * Bounded, not fixed at 1200. The hub always asks for 1200; the range exists so concurrency
     * tests can use a two-second lease and watch it expire without waiting twenty minutes.
     * The provider clamps to its own maximum regardless of what is asked.
     */
    requested_ttl_seconds: { type: 'integer', minimum: 1, maximum: 1200 },
    /** Idempotency key. Same key, same resource, unexpired lease returns the existing lease. */
    client_request_id: opaqueIdSchema,
  },
} as const;

export const providerHoldOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'resource_id', 'status', 'expires_at_epoch_ms', 'ttl_seconds'],
  properties: {
    hold_id: opaqueIdSchema,
    resource_id: resourceIdSchema,
    status: { type: 'string', enum: ['held', 'reused'] },
    /**
     * Absolute expiry, provider clock, as epoch milliseconds.
     *
     * This is the one place absolute time appears in the system, and it has to: a lease is a real
     * wall-clock lease at a real organisation, and the *provider* is the authority on when it ends
     * (Invariant E). The hub renders a countdown from it and never treats its own arithmetic as the
     * truth. Integer rather than a date string so no parser sits between the two clocks.
     */
    expires_at_epoch_ms: { type: 'integer', minimum: 0 },
    ttl_seconds: { type: 'integer', minimum: 1, maximum: 1200 },
  },
} as const;

export const providerReleaseInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id'],
  properties: { hold_id: opaqueIdSchema },
} as const;

export const providerReleaseOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'status'],
  properties: {
    hold_id: opaqueIdSchema,
    /**
     * `expired` is distinct from `released` on purpose. Compensation must be able to report that a
     * lease it tried to release had already lapsed, because "we released it" and "it lapsed" are
     * different statements about what happened to a scarce resource.
     */
    status: { type: 'string', enum: ['released', 'already_released', 'expired', 'converted'] },
  },
} as const;

// ---------------------------------------------------------------------------
// Provider -> hub: referral
// ---------------------------------------------------------------------------

/**
 * The referral payload. The only place in the system where identifying data crosses an origin, and
 * it crosses only after a human pressed Send on it (Invariant D).
 *
 * These are free-ish strings, and that is not a contradiction of §46.1: that rule governs
 * provider -> hub output, where an attacker-controlled string could steer a model. This travels
 * hub -> provider, and its content came from the person, through a panel they read and edited.
 * It is still length-bounded and shape-checked, because a referral is not a place to be relaxed.
 */
export const providerReferralInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'client_request_id', 'person_name', 'contact_method', 'contact_value', 'preferred_contact_window'],
  properties: {
    hold_id: opaqueIdSchema,
    client_request_id: opaqueIdSchema,
    person_name: { type: 'string', minLength: 1, maxLength: 80 },
    contact_method: { type: 'string', enum: ['phone', 'email'] },
    contact_value: { type: 'string', minLength: 3, maxLength: 120 },
    preferred_contact_window: {
      type: 'string',
      enum: ['now', 'morning', 'afternoon', 'evening'],
    },
  },
} as const;

export const providerReferralOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['referral_id', 'hold_id', 'status', 'received_at'],
  properties: {
    referral_id: opaqueIdSchema,
    hold_id: opaqueIdSchema,
    status: { type: 'string', enum: ['accepted', 'duplicate'] },
    received_at: generatedAtSchema,
    /** What the person should expect next. An enum, not a sentence the provider wrote. */
    next_step: {
      type: 'string',
      enum: ['provider_will_call', 'provider_will_email', 'arrive_at_stated_time'],
    },
    /** Wall clock the person is expected, where the provider offers one. */
    expected_at: clockTimeSchema,
  },
} as const;
