/**
 * Named scenarios. Build plan §20, §42.4.
 *
 * The golden need and the plan combinations the demo, the tests and the eval suite all refer to by
 * name. Having one definition of "the golden scenario" is what stops the film and the test suite
 * drifting into describing two different things.
 */

import type { NeedProfile } from '@threshold/contracts';

/**
 * The carer's situation, as her agent would render it.
 *
 * Her words were: her mother has dementia, cannot be left alone overnight, needs a hoist, and she
 * has surgery on Thursday morning. None of that sentence is here. What is here is what the site
 * needs in order to answer, which is the whole design claim, stated as data rather than as prose.
 */
export const GOLDEN_NEED: NeedProfile = {
  service_area: 'demo_central',
  support_kinds: ['respite_bed', 'accessible_transport', 'overnight_homecare'],
  starts_within_hours: 24,
  duration_hours: 48,
  deadline: { day: 1, at: '08:00' },
  dementia_trained: true,
  wheelchair_access: true,
  hoist_required: true,
  same_gender_staff_required: false,
  accepts_pets_required: false,
  spoken_language: 'en',
};

/** The same need with the hoist relaxed, which is what `explain_gap` invites for R21. */
export const NEED_WITHOUT_HOIST: NeedProfile = { ...GOLDEN_NEED, hoist_required: false };

/** A need no seeded offer satisfies, so NO_MATCH is a tested path and not a theoretical one. */
export const NEED_IMPOSSIBLE: NeedProfile = {
  ...GOLDEN_NEED,
  accepts_pets_required: true,
  same_gender_staff_required: true,
  spoken_language: 'fr',
};

export type PlanSpec = {
  role: 'placement' | 'transport' | 'cover';
  provider_id: 'respite-a' | 'homecare-a' | 'transport-a' | 'directory-a' | 'rules-a';
  resource_id: string;
}[];

/** Feasible. The plan the film ends on. */
export const PLAN_FEASIBLE: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
];

/**
 * Infeasible on exactly one link: `arrival_before_admission`, required 06:40, offered 07:10.
 *
 * This is the combination the narration describes, and the single-link property is deliberate. A
 * candidate that failed three checks would be a worse demonstration, because the interesting claim
 * is that the hub names *which* organisation to go back to.
 */
export const PLAN_SLOW_VAN: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T4' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
];

/** Infeasible on `capability_at_both_ends`: the van has no hoist, though the bed does. */
export const PLAN_NO_HOIST_IN_VAN: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T2' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
];

/** Infeasible on `cover_continuity`: cover ends 05:00, collection is 05:50. */
export const PLAN_COVER_GAP: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H7' },
];

/** Infeasible on `single_area`: the bed is in demo_north. */
export const PLAN_WRONG_AREA: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R30' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
];

/** Infeasible on `placement_before_deadline`: in effect at 09:00, after the 08:00 surgery. */
export const PLAN_AFTER_DEADLINE: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R44' },
  { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
  { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
];

/** A placement with no way of getting to it. Tests the missing-role path. */
export const PLAN_PLACEMENT_ONLY: PlanSpec = [
  { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
];

/**
 * Every scenario, with the link each is expected to fail.
 *
 * A table rather than a list of individual tests, so that adding a link kind to the vocabulary
 * without adding a scenario that exercises it is a visible omission. Build plan §34: a guard that
 * has never been seen to fail is a guard whose passing means nothing, and a link that has never been
 * seen to fail is the same thing.
 */
export const LINK_COVERAGE: ReadonlyArray<{
  name: string;
  plan: PlanSpec;
  expectFailing: string | null;
}> = [
  { name: 'feasible', plan: PLAN_FEASIBLE, expectFailing: null },
  { name: 'slow van', plan: PLAN_SLOW_VAN, expectFailing: 'arrival_before_admission' },
  { name: 'no hoist in van', plan: PLAN_NO_HOIST_IN_VAN, expectFailing: 'capability_at_both_ends' },
  { name: 'cover gap', plan: PLAN_COVER_GAP, expectFailing: 'cover_continuity' },
  { name: 'wrong area', plan: PLAN_WRONG_AREA, expectFailing: 'single_area' },
  { name: 'after deadline', plan: PLAN_AFTER_DEADLINE, expectFailing: 'placement_before_deadline' },
];
