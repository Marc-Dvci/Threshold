/**
 * Offer-level matching. Build plan §12.
 *
 * Deterministic, no model. Two functions, and the second is the interesting one:
 *
 *  - `isExactMatch` answers "does this offer satisfy every requirement the person stated".
 *  - `failedRequirements` answers "and if not, which ones, with what was needed and what was
 *    offered". That is what `explain_gap` returns, and it is why the agent never has to guess which
 *    constraint to relax.
 *
 * Requirements are checked per role. A van is not asked to provide 48 hours of care and a bed is not
 * asked how long the journey takes. Applying every rule to every kind would produce confident,
 * deterministic nonsense.
 *
 * What this layer *cannot* see: whether several offers fit each other. T4 satisfies every stated
 * requirement and still cannot be used, because it fails only in relation to R17. That is
 * `composition.ts`, and the split is the point of the product.
 */

import type { Instant, NeedProfile } from '@threshold/contracts';
import { durationHours, minutesOf } from '@threshold/contracts';
import type { NormalizedOffer } from './normalize.js';

/**
 * The reference "now".
 *
 * The coarse search filters (`starts_within_hours`) measure from here. It is a fixed instant rather
 * than `Date.now()` because the whole time model is relative and deterministic: a filter that moves
 * with the wall clock would make the golden scenario pass in the evening and fail in the morning,
 * and the film would be unshootable.
 *
 * 23:00 on day 0, which is the scenario: the carer is doing this at eleven at night.
 */
export const SEARCH_REFERENCE: Instant = { day: 0, at: '23:00' };

export type FailedRequirement = {
  field: string;
  required: string;
  offered: string;
};

function hoursFromReference(instant: Instant, reference: Instant): number {
  return (minutesOf(instant) - minutesOf(reference)) / 60;
}

/** Which capabilities are checked for which role. Mirrors the projection in `projection.ts`. */
function capabilityChecks(
  need: NeedProfile,
  offer: NormalizedOffer,
): Array<{ field: string; required: boolean; offered: boolean }> {
  const c = offer.capabilities;
  const common = [
    { field: 'wheelchair_access', required: need.wheelchair_access, offered: c.wheelchair_access },
    { field: 'hoist_required', required: need.hoist_required, offered: c.hoist_available },
  ];
  if (offer.role === 'transport') {
    // A van carries a person. It does not employ care staff, keep pets, or run dementia training.
    return common;
  }
  return [
    ...common,
    { field: 'dementia_trained', required: need.dementia_trained, offered: c.dementia_trained },
    {
      field: 'same_gender_staff_required',
      required: need.same_gender_staff_required,
      offered: c.same_gender_staff_available,
    },
    { field: 'accepts_pets_required', required: need.accepts_pets_required, offered: c.accepts_pets },
  ];
}

/**
 * Why this offer does not satisfy the stated requirements. Empty means it does.
 *
 * Order is fixed so the reported reason is deterministic: structural first (area, kind), then
 * timing, then capability, then language. A person reading "wrong area" and a person reading "no
 * hoist" need different next steps, and the more structural mismatch is the more useful thing to say
 * first.
 */
export function failedRequirements(
  need: NeedProfile,
  offer: NormalizedOffer,
  options: { reference?: Instant } = {},
): FailedRequirement[] {
  const reference = options.reference ?? SEARCH_REFERENCE;
  const failures: FailedRequirement[] = [];

  if (offer.service_area !== need.service_area) {
    failures.push({
      field: 'service_area',
      required: need.service_area,
      offered: offer.service_area,
    });
  }

  if (!need.support_kinds.includes(offer.support_kind)) {
    failures.push({
      field: 'support_kind',
      required: need.support_kinds.join('|'),
      offered: offer.support_kind,
    });
  }

  // Timing. Every role has a start; only a placement or cover has a meaningful duration.
  const startsIn = hoursFromReference(offer.window.from, reference);
  if (startsIn > need.starts_within_hours) {
    failures.push({
      field: 'starts_within_hours',
      required: `<=${need.starts_within_hours}h`,
      offered: `${startsIn.toFixed(1)}h`,
    });
  }
  if (startsIn < 0) {
    // An offer whose window has already begun. Not a capability failure but not usable either, and
    // silently ranking it would be worse than saying so.
    failures.push({
      field: 'starts_within_hours',
      required: '>=now',
      offered: `${startsIn.toFixed(1)}h`,
    });
  }

  if (offer.role !== 'transport') {
    const capacity = durationHours(offer.window.from, offer.window.to);
    if (offer.role === 'placement' && capacity < need.duration_hours) {
      failures.push({
        field: 'duration_hours',
        required: `>=${need.duration_hours}h`,
        offered: `${capacity}h`,
      });
    }
  }

  for (const check of capabilityChecks(need, offer)) {
    if (check.required && !check.offered) {
      failures.push({ field: check.field, required: 'true', offered: 'false' });
    }
  }

  if (!offer.capabilities.spoken_languages.includes(need.spoken_language)) {
    failures.push({
      field: 'spoken_language',
      required: need.spoken_language,
      offered: offer.capabilities.spoken_languages.join('|'),
    });
  }

  if (offer.units <= 0) {
    failures.push({ field: 'units', required: '>=1', offered: String(offer.units) });
  }

  return failures;
}

export function isExactMatch(
  need: NeedProfile,
  offer: NormalizedOffer,
  options: { reference?: Instant } = {},
): boolean {
  return failedRequirements(need, offer, options).length === 0;
}

/**
 * Requirements a person could reasonably be asked to reconsider.
 *
 * `service_area` and `support_kind` are not on the list: a bed in the wrong town is not a bed you
 * talk someone into. `units` is not either, because it is not a preference. Everything else is a
 * conversation the agent can have, which is precisely the division of labour this design is after:
 * the code says what failed, the model talks to the person about it.
 */
const RELAXABLE_FIELDS = new Set([
  'dementia_trained',
  'same_gender_staff_required',
  'accepts_pets_required',
  'hoist_required',
  'wheelchair_access',
  'starts_within_hours',
  'duration_hours',
  'spoken_language',
]);

export function isRelaxable(failures: readonly FailedRequirement[]): boolean {
  return failures.length > 0 && failures.every((f) => RELAXABLE_FIELDS.has(f.field));
}

/**
 * A near miss fails between one and two requirements.
 *
 * The bound is a product decision, not an arithmetic one. An offer that fails four requirements is
 * not a near miss, it is a different service, and listing it invites an agent to negotiate away
 * four things the person said they needed.
 */
export const NEAR_MISS_MAX_FAILURES = 2;

export function isNearMiss(failures: readonly FailedRequirement[]): boolean {
  if (failures.length === 0 || failures.length > NEAR_MISS_MAX_FAILURES) return false;
  // Wrong area or wrong kind is never a near miss, however few other things fail.
  return !failures.some((f) => f.field === 'service_area' || f.field === 'support_kind');
}
