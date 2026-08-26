/**
 * Provider-side inventory filtering.
 *
 * This runs *inside the provider*, on the provider's own data, answering the projected question the
 * hub asked. It is not the hub's matching engine and must not become it: the hub's job is to decide
 * which offers satisfy the person, this provider's job is to say what it has.
 *
 * The distinction has a practical consequence worth stating. A provider filters conservatively: when
 * it is unsure whether an offer is relevant it returns it, because a near miss the hub can explain
 * is more useful to a person than an omission the hub cannot see. Over-filtering here would delete
 * `explain_gap`'s entire purpose, and the person would never learn that a bed existed which was
 * perfect apart from the hoist.
 */

import type { ProviderOffer, ProviderQuery, SupportKind } from '@threshold/contracts';
import { minutesOf } from '@threshold/contracts';
import { SEARCH_REFERENCE } from '@threshold/domain';

/** The interval an offer occupies, computed provider-side without the hub's normalisation. */
function startOf(offer: ProviderOffer) {
  switch (offer.support_kind) {
    case 'respite_bed':
      return offer.stay.from;
    case 'overnight_homecare':
      return offer.window.from;
    case 'accessible_transport':
      return offer.pickup_earliest;
  }
}

export type InventoryFilterOptions = {
  /**
   * How much slack to allow on the coarse start window.
   *
   * Non-zero on purpose. The hub's `starts_within_hours` is a coarse enum, and an offer that starts
   * an hour outside it may still work once composition looks at the actual instants. Returning it
   * costs a row; withholding it can cost a person a bed.
   */
  startSlackHours?: number;
};

/**
 * Answer a projected query from an inventory.
 *
 * Hard filters only: area, kind, and units. Everything else is left to the hub, which is the only
 * party that knows what the person actually asked for.
 */
export function filterInventory(
  inventory: readonly ProviderOffer[],
  query: ProviderQuery,
  unitsLeft: (resourceId: string) => number,
  options: InventoryFilterOptions = {},
): ProviderOffer[] {
  const slack = (options.startSlackHours ?? 2) * 60;
  const reference = minutesOf(SEARCH_REFERENCE);
  const kinds = new Set<SupportKind>(query.support_kinds);

  return inventory
    .filter((offer) => {
      if (offer.service_area !== query.service_area) return false;
      if (!kinds.has(offer.support_kind)) return false;

      // Nothing already under way, and nothing wildly outside the window asked about.
      const startsIn = minutesOf(startOf(offer)) - reference;
      if (startsIn < 0) return false;
      if (query.starts_within_hours !== undefined) {
        if (startsIn > query.starts_within_hours * 60 + slack) return false;
      }
      return true;
    })
    .map((offer) => ({ ...offer, units: unitsLeft(offer.resource_id) }))
    // A resource with nothing left is not an offer. Reporting it would put a row in front of a
    // person that they cannot act on.
    .filter((offer) => offer.units > 0)
    .sort((a, b) => a.resource_id.localeCompare(b.resource_id));
}

/**
 * The capacity table the lease store is seeded with, derived from the inventory.
 *
 * Derived rather than written twice: the inventory says a resource has one unit, and the store must
 * agree, or the search shows a bed the store will not hold.
 */
export function capacityFromInventory(inventory: readonly ProviderOffer[]) {
  return inventory.map((offer) => ({
    resource_id: offer.resource_id,
    units: offer.units,
    holdable: offer.holdable,
  }));
}
