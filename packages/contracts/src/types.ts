/**
 * Every domain type in the system, derived from the schemas.
 *
 * There is no hand-written copy of any contract in this file. `FromSchema` reads the same `as const`
 * JSON Schema objects that Ajv compiles, so a schema change is a compile error at every use site
 * rather than a silent divergence discovered at runtime in front of a judge.
 *
 * The two-copy alternative (hand-written types beside hand-written schemas) was revision 1.0's
 * shape. It is a permanent tax on every field added and two chances to drift on every field
 * changed.
 */

import type { FromSchema } from 'json-schema-to-ts';

import type {
  clockTimeSchema,
  instantSchema,
  intervalSchema,
  providerStatusSchema,
} from './schemas/common';
import type { needProfileSchema } from './schemas/need-profile';
import type {
  coverOfferSchema,
  offerCapabilitiesSchema,
  placementOfferSchema,
  providerAvailabilitySchema,
  providerHoldInputSchema,
  providerHoldOutputSchema,
  providerQuerySchema,
  providerReferralInputSchema,
  providerReferralOutputSchema,
  providerReleaseInputSchema,
  providerReleaseOutputSchema,
  transportOfferSchema,
} from './schemas/provider';
import type {
  checkPlanInputSchema,
  checkPlanOutputSchema,
  compensationEntrySchema,
  composedPlanSchema,
  leaseSchema,
  linkResultSchema,
  orchestrationFailureSchema,
  placePlanHoldsInputSchema,
  placePlanHoldsOutputSchema,
  planPartSchema,
  releasePlanInputSchema,
  releasePlanOutputSchema,
} from './schemas/composition';
import type {
  explainGapInputSchema,
  explainGapOutputSchema,
  findSupportInputSchema,
  findSupportOutputSchema,
  getPlanInputSchema,
  getPlanOutputSchema,
  makeReferralInputSchema,
  makeReferralOutputSchema,
  placeHoldInputSchema,
  placeHoldOutputSchema,
  releaseHoldInputSchema,
  releaseHoldOutputSchema,
} from './schemas/hub-tools';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type ClockTime = FromSchema<typeof clockTimeSchema>;
export type Instant = FromSchema<typeof instantSchema>;
export type Interval = FromSchema<typeof intervalSchema>;
export type ProviderStatus = FromSchema<typeof providerStatusSchema>;

// ---------------------------------------------------------------------------
// Need
// ---------------------------------------------------------------------------

export type NeedProfile = FromSchema<typeof needProfileSchema>;

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export type ProviderQuery = FromSchema<typeof providerQuerySchema>;
export type OfferCapabilities = FromSchema<typeof offerCapabilitiesSchema>;

export type PlacementOffer = FromSchema<typeof placementOfferSchema>;
export type TransportOffer = FromSchema<typeof transportOfferSchema>;
export type CoverOffer = FromSchema<typeof coverOfferSchema>;
export type ProviderOffer = PlacementOffer | TransportOffer | CoverOffer;

export type ProviderAvailability = FromSchema<typeof providerAvailabilitySchema>;

export type ProviderHoldInput = FromSchema<typeof providerHoldInputSchema>;
export type ProviderHoldOutput = FromSchema<typeof providerHoldOutputSchema>;
export type ProviderReleaseInput = FromSchema<typeof providerReleaseInputSchema>;
export type ProviderReleaseOutput = FromSchema<typeof providerReleaseOutputSchema>;
export type ProviderReferralInput = FromSchema<typeof providerReferralInputSchema>;
export type ProviderReferralOutput = FromSchema<typeof providerReferralOutputSchema>;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type PlanPart = FromSchema<typeof planPartSchema>;
export type ComposedPlan = FromSchema<typeof composedPlanSchema>;
export type LinkResult = FromSchema<typeof linkResultSchema>;
export type Lease = FromSchema<typeof leaseSchema>;
export type CompensationEntry = FromSchema<typeof compensationEntrySchema>;
export type OrchestrationFailure = FromSchema<typeof orchestrationFailureSchema>;

export type CheckPlanInput = FromSchema<typeof checkPlanInputSchema>;
export type CheckPlanOutput = FromSchema<typeof checkPlanOutputSchema>;
export type PlacePlanHoldsInput = FromSchema<typeof placePlanHoldsInputSchema>;
export type PlacePlanHoldsOutput = FromSchema<typeof placePlanHoldsOutputSchema>;
export type ReleasePlanInput = FromSchema<typeof releasePlanInputSchema>;
export type ReleasePlanOutput = FromSchema<typeof releasePlanOutputSchema>;

/** A failing link, narrowed out of the LinkResult union. Used everywhere a reason is reported. */
export type FailedLink = Extract<LinkResult, { ok: false }>;
export type SatisfiedLink = Extract<LinkResult, { ok: true }>;

// ---------------------------------------------------------------------------
// Hub tool contract
// ---------------------------------------------------------------------------

export type FindSupportInput = FromSchema<typeof findSupportInputSchema>;
export type FindSupportOutput = FromSchema<typeof findSupportOutputSchema>;
export type NormalizedMatch = FindSupportOutput['exact_matches'][number];
export type NormalizedNearMiss = FindSupportOutput['near_misses'][number];

export type ExplainGapInput = FromSchema<typeof explainGapInputSchema>;
export type ExplainGapOutput = FromSchema<typeof explainGapOutputSchema>;

export type PlaceHoldInput = FromSchema<typeof placeHoldInputSchema>;
export type PlaceHoldOutput = FromSchema<typeof placeHoldOutputSchema>;
export type ReleaseHoldInput = FromSchema<typeof releaseHoldInputSchema>;
export type ReleaseHoldOutput = FromSchema<typeof releaseHoldOutputSchema>;

export type MakeReferralInput = FromSchema<typeof makeReferralInputSchema>;
export type MakeReferralOutput = FromSchema<typeof makeReferralOutputSchema>;

export type GetPlanInput = FromSchema<typeof getPlanInputSchema>;
export type GetPlanOutput = FromSchema<typeof getPlanOutputSchema>;

/** The four referral fields, as a type, so nothing can log or send a fifth. */
export type ReferralFieldName = MakeReferralOutput['fields_sent'][number];
