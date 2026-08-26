/**
 * Ranking. Build plan §12.3, §42.6.
 *
 * Deterministic and explainable, with a stable tie-breaker so two runs produce the same order and a
 * take can be re-recorded. No weighted score: an opaque number would be unarguable, and every
 * criterion here is one a person can be told out loud.
 */

import type { NeedProfile } from '@threshold/contracts';
import { durationHours, minutesOf } from '@threshold/contracts';
import type { NormalizedOffer } from './normalize.js';

/**
 * Offers, best first.
 *
 * 1. earlier start, because the person is arranging this at eleven at night;
 * 2. closer duration fit, so a 72-hour bed does not beat a 48-hour bed for a 48-hour need;
 * 3. directory-attested before self-asserted, so a claim someone else records outranks a claim an
 *    organisation makes about itself;
 * 4. resource id, purely so the order is total.
 */
export function rankOffers(
  need: NeedProfile,
  offers: readonly NormalizedOffer[],
): NormalizedOffer[] {
  return [...offers].sort((a, b) => {
    const startDiff = minutesOf(a.window.from) - minutesOf(b.window.from);
    if (startDiff !== 0) return startDiff;

    if (a.role === 'placement' && b.role === 'placement') {
      const fit = (o: NormalizedOffer) =>
        Math.abs(durationHours(o.window.from, o.window.to) - need.duration_hours);
      const fitDiff = fit(a) - fit(b);
      if (fitDiff !== 0) return fitDiff;
    }

    const attest = (o: NormalizedOffer) => (o.assertion_class === 'directory_attested' ? 0 : 1);
    const attestDiff = attest(a) - attest(b);
    if (attestDiff !== 0) return attestDiff;

    return a.resource_id.localeCompare(b.resource_id);
  });
}

/**
 * Candidate plans, best first: fewest failing links, then earliest completion.
 *
 * Ranking by failure count rather than filtering to the feasible ones is the useful behaviour. When
 * nothing fits, "this one is a single phone call away" is a far better thing to hand a person than an
 * empty list.
 */
export function rankPlanCandidates<T extends { failingLinks: number; completesAt: number }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort(
    (a, b) => a.failingLinks - b.failingLinks || a.completesAt - b.completesAt,
  );
}
