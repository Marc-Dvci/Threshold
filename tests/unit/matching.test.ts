/**
 * Projection, normalisation, matching and ranking. Build plan §10.2, §12, §27.1.
 *
 * The deterministic core, tested on its own. Every rule here is one a person can be told out loud
 * and can argue with, and each test is written as the sentence a person would be told.
 */

import { describe, expect, it } from 'vitest';

import {
  GOLDEN_NEED,
  HOMECARE_INVENTORY,
  NEED_WITHOUT_HOIST,
  RESPITE_INVENTORY,
  TRANSPORT_INVENTORY,
} from '@threshold/test-fixtures';
import type { NeedProfile, PlacementOffer, ProviderOffer, TransportOffer } from '@threshold/contracts';
import {
  SEARCH_REFERENCE,
  failedRequirements,
  isExactMatch,
  isNearMiss,
  isRelaxable,
  normalizeOffer,
  projectNeedForProvider,
  projectedFieldNames,
  rankOffers,
  rolesRequested,
  type NormalizedOffer,
} from '@threshold/domain';

const offer = (raw: ProviderOffer): NormalizedOffer =>
  normalizeOffer(raw, { provider_id: 'respite-a', assertion_class: 'self_asserted' });

const byId = <T extends ProviderOffer>(list: readonly T[], id: string): T =>
  list.find((o) => o.resource_id === id)!;

const R17 = byId<PlacementOffer>(RESPITE_INVENTORY, 'R17');
const R21 = byId<PlacementOffer>(RESPITE_INVENTORY, 'R21');
const R30 = byId<PlacementOffer>(RESPITE_INVENTORY, 'R30');
const T4 = byId<TransportOffer>(TRANSPORT_INVENTORY, 'T4');
const T2 = byId<TransportOffer>(TRANSPORT_INVENTORY, 'T2');
const T9 = byId<TransportOffer>(TRANSPORT_INVENTORY, 'T9');

describe('projection: what an organisation is told', () => {
  it('omits a capability it does not deal in rather than sending it as false', () => {
    const query = projectNeedForProvider(GOLDEN_NEED, { supportKinds: ['accessible_transport'] })!;

    // A van has no business knowing the person needs dementia-trained staff. Sending `false` would
    // still disclose that the question was asked, and "does this person need same-gender staff: no"
    // is information about the person. Minimisation means absent, not negative.
    expect(query.required_capabilities).toEqual({
      wheelchair_access: true,
      hoist_available: true,
      spoken_language: 'en',
    });
    expect(query.required_capabilities).not.toHaveProperty('dementia_trained');
    expect(query.required_capabilities).not.toHaveProperty('same_gender_staff_available');
  });

  it('omits a requirement the person did not make, even where it is relevant', () => {
    const query = projectNeedForProvider(GOLDEN_NEED, { supportKinds: ['respite_bed'] })!;
    // `accepts_pets_required` is false in the golden need, so the question is never asked.
    expect(query.required_capabilities).not.toHaveProperty('accepts_pets');
    expect(query.required_capabilities.dementia_trained).toBe(true);
  });

  it('does not call an organisation that deals in nothing the person asked for', () => {
    const narrow: NeedProfile = { ...GOLDEN_NEED, support_kinds: ['respite_bed'] };
    expect(projectNeedForProvider(narrow, { supportKinds: ['accessible_transport'] })).toBeNull();
  });

  it('reports the field names it sent, for the boundary log', () => {
    const query = projectNeedForProvider(GOLDEN_NEED, { supportKinds: ['accessible_transport'] })!;
    expect(projectedFieldNames(query)).toEqual([
      'service_area',
      'support_kinds',
      'wheelchair_access',
      'hoist_available',
      'spoken_language',
      'starts_within_hours',
      'min_duration_hours',
    ]);
  });

  it('knows which roles a need is asking to fill', () => {
    expect(rolesRequested(GOLDEN_NEED).sort()).toEqual(['cover', 'placement', 'transport']);
  });
});

describe('normalisation: what the hub derives for itself', () => {
  it('computes a van arrival rather than believing a published one', () => {
    // A provider that stated its own arrival time could state a convenient one, and the arrival
    // time is exactly the number the whole plan turns on.
    expect(offer(T4).arrival).toEqual({ day: 1, at: '07:10' });
    expect(offer(T9).arrival).toEqual({ day: 1, at: '06:25' });
    expect(T4).not.toHaveProperty('arrival');
  });

  it('gives every role a comparable window', () => {
    expect(offer(R17).window).toEqual(R17.stay);
    expect(offer(T9).window).toEqual({ from: { day: 1, at: '05:50' }, to: { day: 1, at: '06:25' } });
    expect(offer(HOMECARE_INVENTORY[0]!).window).toEqual(HOMECARE_INVENTORY[0]!.window);
  });

  it('labels the claim class from the registry, not from the payload', () => {
    const attested = normalizeOffer(R17, {
      provider_id: 'directory-a',
      assertion_class: 'directory_attested',
    });
    expect(attested.assertion_class).toBe('directory_attested');
    expect(attested.provider_id).toBe('directory-a');
  });
});

describe('matching: which requirements an offer fails', () => {
  it('accepts the bed the film is about', () => {
    expect(failedRequirements(GOLDEN_NEED, offer(R17))).toEqual([]);
    expect(isExactMatch(GOLDEN_NEED, offer(R17))).toBe(true);
  });

  it('names the one requirement a near miss fails, with required and offered', () => {
    const failures = failedRequirements(GOLDEN_NEED, offer(R21));
    expect(failures).toEqual([{ field: 'hoist_required', required: 'true', offered: 'false' }]);
    expect(isNearMiss(failures)).toBe(true);
    expect(isRelaxable(failures)).toBe(true);
    // And relaxing exactly that requirement is what opens it up.
    expect(isExactMatch(NEED_WITHOUT_HOIST, offer(R21))).toBe(true);
  });

  it('reports structural mismatches before capability ones', () => {
    const failures = failedRequirements(GOLDEN_NEED, offer(R30));
    // A person reading "wrong area" and a person reading "no hoist" need different next steps, and
    // the more structural mismatch is the more useful thing to say first.
    expect(failures[0]?.field).toBe('service_area');
    expect(failures[0]).toEqual({
      field: 'service_area',
      required: 'demo_central',
      offered: 'demo_north',
    });
  });

  it('is never a near miss when the area or the kind is wrong', () => {
    // A bed in the wrong town is not a bed you talk someone into, however few other things fail.
    expect(isNearMiss(failedRequirements(GOLDEN_NEED, offer(R30)))).toBe(false);
    expect(isRelaxable(failedRequirements(GOLDEN_NEED, offer(R30)))).toBe(false);
  });

  it('does not ask a van the questions that belong to a care home', () => {
    // T2 has no hoist, which a van does need. It is not asked about dementia training, pets or
    // staff gender, and applying those rules to it would produce confident, deterministic nonsense.
    const failures = failedRequirements(GOLDEN_NEED, offer(T2));
    expect(failures.map((f) => f.field)).toEqual(['hoist_required']);
  });

  it('passes an offer that satisfies every stated requirement and still cannot be used', () => {
    // The whole argument for composition, in one assertion. T4 is an exact match at offer level:
    // right area, hoist, wheelchair, available well inside the window. It fails only in relation to
    // R17, and nothing at this layer can see that.
    expect(isExactMatch(GOLDEN_NEED, offer(T4))).toBe(true);
  });

  it('measures the start window from a fixed reference, not the wall clock', () => {
    // A filter that moved with the clock would make the golden scenario pass in the evening and
    // fail in the morning, and the film would be unshootable.
    expect(SEARCH_REFERENCE).toEqual({ day: 0, at: '23:00' });
    const tight: NeedProfile = { ...GOLDEN_NEED, starts_within_hours: 6 };
    const failures = failedRequirements(tight, offer(R17));
    expect(failures).toEqual([
      { field: 'starts_within_hours', required: '<=6h', offered: '7.7h' },
    ]);
  });

  it('rejects a resource with nothing left', () => {
    const depleted = { ...offer(R17), units: 0 };
    expect(failedRequirements(GOLDEN_NEED, depleted)).toContainEqual({
      field: 'units',
      required: '>=1',
      offered: '0',
    });
  });
});

describe('ranking', () => {
  it('puts the earliest start first and breaks every tie the same way twice', () => {
    const offers = [offer(R17), offer(T9), offer(T4), offer(HOMECARE_INVENTORY[0]!)];
    const once = rankOffers(GOLDEN_NEED, offers).map((o) => o.resource_id);
    const twice = rankOffers(GOLDEN_NEED, [...offers].reverse()).map((o) => o.resource_id);

    expect(once).toEqual(['H3', 'T9', 'T4', 'R17']);
    // Deterministic under a different input order, so two runs produce the same page and a take can
    // be re-recorded.
    expect(twice).toEqual(once);
  });

  it('prefers a bed that fits the stay over one that overshoots it', () => {
    const tight: PlacementOffer = {
      ...R17,
      resource_id: 'R18',
      stay: { from: { day: 1, at: '06:40' }, to: { day: 5, at: '06:40' } },
    };
    const ranked = rankOffers(GOLDEN_NEED, [offer(tight), offer(R17)]);
    // Both start at the same moment; the 48-hour need takes the 48-hour bed, not the 96-hour one.
    expect(ranked[0]?.resource_id).toBe('R17');
  });

  it('puts a directory-attested claim above an organisation asserting it about itself', () => {
    const selfAsserted = offer(R17);
    const attested = normalizeOffer(R17, {
      provider_id: 'directory-a',
      assertion_class: 'directory_attested',
    });
    expect(rankOffers(GOLDEN_NEED, [selfAsserted, attested])[0]?.assertion_class).toBe(
      'directory_attested',
    );
  });
});
