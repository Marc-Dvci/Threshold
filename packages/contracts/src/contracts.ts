/**
 * The compiled validator registry.
 *
 * One place where every contract in the system is named and compiled. Two things fall out of that
 * which are worth the file:
 *
 *  - the diagnostics panel and `/verify` can list every contract the build actually enforces, so
 *    "everything is validated" is inspectable rather than asserted;
 *  - `tests/security` can walk this registry and assert a structural property over *all* provider
 *    output contracts at once, which is how the no-free-form-string rule stays true as contracts are
 *    added. A rule enforced by review is a rule that lapses.
 */

import {
  checkPlanInputSchema,
  checkPlanOutputSchema,
  composedPlanSchema,
  placePlanHoldsInputSchema,
  placePlanHoldsOutputSchema,
  releasePlanInputSchema,
  releasePlanOutputSchema,
} from './schemas/composition';
import {
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
import {
  providerAvailabilitySchema,
  providerHoldInputSchema,
  providerHoldOutputSchema,
  providerQuerySchema,
  providerReferralInputSchema,
  providerReferralOutputSchema,
  providerReleaseInputSchema,
  providerReleaseOutputSchema,
} from './schemas/provider';
import { validator } from './validate';
import type {
  CheckPlanInput,
  CheckPlanOutput,
  ComposedPlan,
  ExplainGapInput,
  ExplainGapOutput,
  FindSupportInput,
  FindSupportOutput,
  GetPlanInput,
  GetPlanOutput,
  MakeReferralInput,
  MakeReferralOutput,
  PlaceHoldInput,
  PlaceHoldOutput,
  PlacePlanHoldsInput,
  PlacePlanHoldsOutput,
  ProviderAvailability,
  ProviderHoldInput,
  ProviderHoldOutput,
  ProviderQuery,
  ProviderReferralInput,
  ProviderReferralOutput,
  ProviderReleaseInput,
  ProviderReleaseOutput,
  ReleaseHoldInput,
  ReleaseHoldOutput,
  ReleasePlanInput,
  ReleasePlanOutput,
} from './types';

// ---------------------------------------------------------------------------
// Agent -> hub
// ---------------------------------------------------------------------------

export const V = {
  findSupportInput: validator<FindSupportInput>('find_support.input', findSupportInputSchema),
  findSupportOutput: validator<FindSupportOutput>('find_support.output', findSupportOutputSchema),
  explainGapInput: validator<ExplainGapInput>('explain_gap.input', explainGapInputSchema),
  explainGapOutput: validator<ExplainGapOutput>('explain_gap.output', explainGapOutputSchema),
  checkPlanInput: validator<CheckPlanInput>('check_plan.input', checkPlanInputSchema),
  checkPlanOutput: validator<CheckPlanOutput>('check_plan.output', checkPlanOutputSchema),
  placeHoldInput: validator<PlaceHoldInput>('place_hold.input', placeHoldInputSchema),
  placeHoldOutput: validator<PlaceHoldOutput>('place_hold.output', placeHoldOutputSchema),
  placePlanHoldsInput: validator<PlacePlanHoldsInput>('place_plan_holds.input', placePlanHoldsInputSchema),
  placePlanHoldsOutput: validator<PlacePlanHoldsOutput>('place_plan_holds.output', placePlanHoldsOutputSchema),
  releaseHoldInput: validator<ReleaseHoldInput>('release_hold.input', releaseHoldInputSchema),
  releaseHoldOutput: validator<ReleaseHoldOutput>('release_hold.output', releaseHoldOutputSchema),
  releasePlanInput: validator<ReleasePlanInput>('release_plan.input', releasePlanInputSchema),
  releasePlanOutput: validator<ReleasePlanOutput>('release_plan.output', releasePlanOutputSchema),
  makeReferralInput: validator<MakeReferralInput>('make_referral.input', makeReferralInputSchema),
  makeReferralOutput: validator<MakeReferralOutput>('make_referral.output', makeReferralOutputSchema),
  getPlanInput: validator<GetPlanInput>('get_plan.input', getPlanInputSchema),
  getPlanOutput: validator<GetPlanOutput>('get_plan.output', getPlanOutputSchema),

  // Internal
  composedPlan: validator<ComposedPlan>('internal.composed_plan', composedPlanSchema),

  // Hub -> provider
  providerQuery: validator<ProviderQuery>('provider.query_availability.input', providerQuerySchema),
  providerHoldInput: validator<ProviderHoldInput>('provider.hold.input', providerHoldInputSchema),
  providerReleaseInput: validator<ProviderReleaseInput>('provider.release_hold.input', providerReleaseInputSchema),
  providerReferralInput: validator<ProviderReferralInput>('provider.accept_referral.input', providerReferralInputSchema),

  // Provider -> hub. THE trust boundary.
  providerAvailability: validator<ProviderAvailability>('provider.query_availability.output', providerAvailabilitySchema),
  providerHoldOutput: validator<ProviderHoldOutput>('provider.hold.output', providerHoldOutputSchema),
  providerReleaseOutput: validator<ProviderReleaseOutput>('provider.release_hold.output', providerReleaseOutputSchema),
  providerReferralOutput: validator<ProviderReferralOutput>('provider.accept_referral.output', providerReferralOutputSchema),
} as const;

/**
 * The provider -> hub contracts, by name.
 *
 * These four are the only schemas that describe data authored outside this system. The
 * no-free-form-string rule (§46.1) applies to exactly this set, and `tests/security` enumerates it
 * from here so that adding a fifth provider output contract without constraining its strings is a
 * test failure rather than a review miss.
 */
export const PROVIDER_OUTPUT_SCHEMAS = {
  'provider.query_availability.output': providerAvailabilitySchema,
  'provider.hold.output': providerHoldOutputSchema,
  'provider.release_hold.output': providerReleaseOutputSchema,
  'provider.accept_referral.output': providerReferralOutputSchema,
} as const;

/** Every hub tool name, in registration order. Used by the tool lifecycle manager and by evals. */
export const HUB_TOOL_NAMES = [
  'find_support',
  'explain_gap',
  'check_plan',
  'place_hold',
  'place_plan_holds',
  'release_hold',
  'release_plan',
  'make_referral',
  'get_plan',
] as const;

export type HubToolName = (typeof HUB_TOOL_NAMES)[number];

/** Every provider tool name. A provider need not implement all four (the directory implements one). */
export const PROVIDER_TOOL_NAMES = [
  'query_availability',
  'hold',
  'release_hold',
  'accept_referral',
] as const;

export type ProviderToolName = (typeof PROVIDER_TOOL_NAMES)[number];
