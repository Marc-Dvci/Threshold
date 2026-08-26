/**
 * The capability vocabulary.
 *
 * Single source of truth for every enum in the system. Schemas reference these arrays, TypeScript
 * types are derived from them, and the UI renders labels keyed off them. Adding a capability means
 * adding it here and nowhere else.
 *
 * Build plan §7.2, §42.6, §46.1.
 */

// ---------------------------------------------------------------------------
// Areas, kinds, roles
// ---------------------------------------------------------------------------

export const SERVICE_AREAS = ['demo_north', 'demo_central', 'demo_south'] as const;
export type ServiceArea = (typeof SERVICE_AREAS)[number];

export const SUPPORT_KINDS = [
  'respite_bed',
  'overnight_homecare',
  'accessible_transport',
] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

/**
 * The role a part plays inside a composed plan. Deliberately distinct from SupportKind: the role is
 * about the *shape of the plan*, the kind is about what a provider sells. A plan needs exactly one
 * placement, and may need a transport and a cover leg to make that placement reachable and safe.
 */
export const PLAN_PART_ROLES = ['placement', 'transport', 'cover'] as const;
export type PlanPartRole = (typeof PLAN_PART_ROLES)[number];

/** Which support kinds can fill which plan role. Used by composition, never by the model. */
export const ROLE_KINDS: Readonly<Record<PlanPartRole, readonly SupportKind[]>> = {
  placement: ['respite_bed'],
  transport: ['accessible_transport'],
  cover: ['overnight_homecare'],
};

export const KIND_ROLE: Readonly<Record<SupportKind, PlanPartRole>> = {
  respite_bed: 'placement',
  accessible_transport: 'transport',
  overnight_homecare: 'cover',
};

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Spoken-language capability. This is what the *service* can speak, not the language the person
 * reads the site in: the agent handles interface language, the schema is the interlingua
 * (capability map §2.6).
 */
export const SPOKEN_LANGUAGES = ['en', 'uk', 'fr', 'other'] as const;
export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// Coarse search enums
// ---------------------------------------------------------------------------

/**
 * Search filters are coarse enums, deliberately. They narrow the fan-out. Composition (§42) does
 * the exact comparison against the instants a provider actually offers, so these never need to be
 * precise, and keeping them coarse keeps the capability vector small.
 */
export const STARTS_WITHIN_HOURS = [6, 12, 24, 48, 72] as const;
export type StartsWithinHours = (typeof STARTS_WITHIN_HOURS)[number];

export const DURATION_HOURS = [4, 8, 12, 24, 48, 72] as const;
export type DurationHours = (typeof DURATION_HOURS)[number];

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Provider identifiers, as an enum.
 *
 * This is a security control, not bookkeeping. §46.1: every field a provider returns must be an
 * enum, a boolean, a number, or a string under a pattern, so that there is no free-form string
 * surface in the result contract for an instruction to hide in. A free-string `provider_id` would
 * be exactly such a surface.
 */
export const PROVIDER_IDS = [
  'respite-a',
  'homecare-a',
  'transport-a',
  'directory-a',
  'rules-a',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How a capability claim was obtained. Set by the hub from the provider registry, never by the
 * provider: a provider must not be able to promote its own claims.
 *
 * This does not detect a lying provider and does not pretend to (§46.2). It makes the difference
 * visible between a claim an organisation made about itself and one a public directory records.
 */
export const ASSERTION_CLASSES = ['self_asserted', 'directory_attested'] as const;
export type AssertionClass = (typeof ASSERTION_CLASSES)[number];

export const PROVIDER_STATES = ['ok', 'timeout', 'unavailable', 'contract_error'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Wall-clock time, "HH:MM", 24 hour.
 *
 * There is no timezone anywhere in this system. Every party in a coordination event is in the same
 * locality by construction (a service area), so wall clock plus a day offset is both sufficient and
 * a great deal safer than carrying offsets through four independent origins. It also means the
 * value a judge reads in DevTools is the value the film says out loud.
 */
export const CLOCK_TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

/** Days after the search date. 0 is today, 1 is tomorrow. Bounded so a plan cannot run away. */
export const DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type DayOffset = (typeof DAY_OFFSETS)[number];

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The link vocabulary: the ways in which parts of a plan held at *different* organisations can fail
 * to fit each other. Build plan §42.2.
 *
 * Evaluation order is fixed (see LINK_ORDER) so that the reported failing link is deterministic.
 */
export const LINK_KINDS = [
  'single_area',
  'capability_at_both_ends',
  'arrival_before_admission',
  'cover_continuity',
  'placement_before_deadline',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Fixed evaluation order. Not alphabetical: cheapest and most structural checks first. */
export const LINK_ORDER: readonly LinkKind[] = LINK_KINDS;

/** Human-readable label per link, for the UI and the plan document. */
export const LINK_LABELS: Readonly<Record<LinkKind, string>> = {
  single_area: 'All parts serve the same area',
  capability_at_both_ends: 'Required equipment available at both ends of the journey',
  arrival_before_admission: 'Transport arrives before the admission cut-off',
  cover_continuity: 'Overnight cover lasts until collection',
  placement_before_deadline: 'The placement is in effect before the deadline',
};
