/**
 * Normalisation: validated provider offer -> the hub's own typed representation.
 *
 * This is the projection step of the trust firewall (§11.2). It runs *after* Ajv has accepted the
 * payload and it is not a formality: validation proves a payload matches a shape, normalisation
 * decides which of those fields the rest of the system is allowed to see, and derives the ones the
 * hub computes for itself.
 *
 * Two derived fields matter:
 *
 *  - `arrival`, from `pickup_earliest + journey_minutes`. Derived, never published by the provider.
 *    A provider that stated its own arrival time could state a convenient one, and the arrival time
 *    is exactly the number the plan turns on.
 *  - `assertion_class`, from the provider registry. Set by the hub, so an organisation cannot
 *    promote its own claims to directory-attested.
 */

import type {
  AssertionClass,
  Instant,
  Interval,
  OfferCapabilities,
  PlanPartRole,
  ProviderAvailability,
  ProviderId,
  ProviderOffer,
  ServiceArea,
  SupportKind,
} from '@threshold/contracts';
import { KIND_ROLE, addMinutes } from '@threshold/contracts';

/**
 * The hub's internal record of one offer.
 *
 * Richer than what the agent sees, because composition needs the timing detail and the agent does
 * not. `find_support` projects this down to fit the output budget.
 */
export type NormalizedOffer = {
  provider_id: ProviderId;
  resource_id: string;
  role: PlanPartRole;
  support_kind: SupportKind;
  service_area: ServiceArea;
  capabilities: OfferCapabilities;
  holdable: boolean;
  units: number;
  assertion_class: AssertionClass;
  /** The interval this offer occupies, whatever its role. Lets links compare like with like. */
  window: Interval;
  /** Placement only. `to` is the admission cut-off. */
  admission?: Interval;
  /** Transport only. */
  pickup_earliest?: Instant;
  pickup_latest?: Instant;
  journey_minutes?: number;
  /** Transport only, derived by the hub from pickup and journey time. */
  arrival?: Instant;
};

/** The interval an offer occupies, per role. */
function windowOf(offer: ProviderOffer): Interval {
  switch (offer.support_kind) {
    case 'respite_bed':
      return offer.stay;
    case 'overnight_homecare':
      return offer.window;
    case 'accessible_transport':
      return {
        from: offer.pickup_earliest,
        to: addMinutes(offer.pickup_earliest, offer.journey_minutes),
      };
  }
}

export function normalizeOffer(
  offer: ProviderOffer,
  context: { provider_id: ProviderId; assertion_class: AssertionClass },
): NormalizedOffer {
  const base: NormalizedOffer = {
    provider_id: context.provider_id,
    resource_id: offer.resource_id,
    role: KIND_ROLE[offer.support_kind],
    support_kind: offer.support_kind,
    service_area: offer.service_area,
    capabilities: offer.capabilities,
    holdable: offer.holdable,
    units: offer.units,
    assertion_class: context.assertion_class,
    window: windowOf(offer),
  };

  if (offer.support_kind === 'respite_bed') {
    base.admission = offer.admission;
  }
  if (offer.support_kind === 'accessible_transport') {
    base.pickup_earliest = offer.pickup_earliest;
    base.pickup_latest = offer.pickup_latest;
    base.journey_minutes = offer.journey_minutes;
    base.arrival = addMinutes(offer.pickup_earliest, offer.journey_minutes);
  }

  return base;
}

/**
 * Normalise a whole validated availability payload.
 *
 * `provider_id` comes from the *registry entry the hub called*, not from the payload, even though
 * the payload carries one and it validated. A provider claiming to be another provider is the sort
 * of thing that should be impossible by construction rather than caught by a comparison, and this
 * is where that is arranged. The mismatch is still reported, because a provider whose declared id
 * disagrees with its origin is worth knowing about.
 */
export function normalizeAvailability(
  payload: ProviderAvailability,
  context: { provider_id: ProviderId; assertion_class: AssertionClass },
): { offers: NormalizedOffer[]; identityMismatch: boolean } {
  return {
    offers: payload.offers.map((offer) => normalizeOffer(offer, context)),
    identityMismatch: payload.provider_id !== context.provider_id,
  };
}

/** Every field name that survived projection. Used by the boundary log and the diagnostics panel. */
export const NORMALIZED_FIELDS: readonly string[] = [
  'provider_id',
  'resource_id',
  'role',
  'support_kind',
  'service_area',
  'capabilities',
  'holdable',
  'units',
  'assertion_class',
  'window',
  'admission',
  'pickup_earliest',
  'pickup_latest',
  'journey_minutes',
  'arrival',
];
