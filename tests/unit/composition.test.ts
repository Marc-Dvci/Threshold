/**
 * The joint feasibility engine.
 *
 * The most important test file in the project. If composition is wrong, the product is a booking
 * site and the federation is decoration.
 *
 * Note what is being asserted throughout: not just "infeasible" but *which* link failed, with the
 * required and offered values. A checker that says no for the wrong reason is worse than one that
 * says nothing, because the agent will then renegotiate with the wrong organisation.
 */

import { describe, expect, it } from 'vitest';

import { V, type ComposedPlan, type NeedProfile } from '@threshold/contracts';
import {
  buildPlanParts,
  checkPlan,
  failedLinks,
  normalizeOffer,
  alternativesForRole,
  type NormalizedOffer,
  type PartRequest,
} from '@threshold/domain';
import {
  GOLDEN_NEED,
  HOMECARE_INVENTORY,
  LINK_COVERAGE,
  PLAN_FEASIBLE,
  PLAN_PLACEMENT_ONLY,
  PLAN_SLOW_VAN,
  RESPITE_INVENTORY,
  TRANSPORT_INVENTORY,
} from '@threshold/test-fixtures';

// ---------------------------------------------------------------------------
// Build the hub's validated store from the seed inventories, the same way the real fan-out does.
// ---------------------------------------------------------------------------

const OFFERS: NormalizedOffer[] = [
  ...RESPITE_INVENTORY.map((o) =>
    normalizeOffer(o, { provider_id: 'respite-a', assertion_class: 'self_asserted' }),
  ),
  ...TRANSPORT_INVENTORY.map((o) =>
    normalizeOffer(o, { provider_id: 'transport-a', assertion_class: 'self_asserted' }),
  ),
  ...HOMECARE_INVENTORY.map((o) =>
    normalizeOffer(o, { provider_id: 'homecare-a', assertion_class: 'self_asserted' }),
  ),
];

function plan(requests: readonly PartRequest[], need: NeedProfile = GOLDEN_NEED): ComposedPlan {
  const built = buildPlanParts(requests, OFFERS);
  if ('error' in built) throw new Error(`fixture plan did not build: ${JSON.stringify(built.error)}`);
  return { plan_id: 'plan_test000001', search_id: 'search_test0001', need, parts: built.parts };
}

// ---------------------------------------------------------------------------

describe('derived fields', () => {
  it('derives transport arrival from pickup plus journey, never from the provider', () => {
    const t9 = OFFERS.find((o) => o.resource_id === 'T9')!;
    // 05:50 + 35 = 06:25
    expect(t9.arrival).toEqual({ day: 1, at: '06:25' });

    const t4 = OFFERS.find((o) => o.resource_id === 'T4')!;
    // 06:00 + 70 = 07:10. This is the number the film says out loud.
    expect(t4.arrival).toEqual({ day: 1, at: '07:10' });
  });

  it('gives every role a comparable window', () => {
    expect(OFFERS.find((o) => o.resource_id === 'R17')!.window).toEqual({
      from: { day: 1, at: '06:40' },
      to: { day: 3, at: '06:40' },
    });
    expect(OFFERS.find((o) => o.resource_id === 'H3')!.window).toEqual({
      from: { day: 0, at: '23:30' },
      to: { day: 1, at: '06:00' },
    });
  });
});

describe('the golden plan', () => {
  it('R17 + T9 + H3 is feasible', () => {
    const result = checkPlan(plan(PLAN_FEASIBLE));
    expect(result.feasible).toBe(true);
    expect(failedLinks(result)).toEqual([]);
    expect(result.missingRoles).toEqual([]);
  });

  it('reports every applicable link as satisfied, and no inapplicable one', () => {
    const result = checkPlan(plan(PLAN_FEASIBLE));
    const kinds = result.links.map((l) => l.kind).sort();
    expect(kinds).toEqual([
      'arrival_before_admission',
      'capability_at_both_ends',
      'cover_continuity',
      'placement_before_deadline',
      'single_area',
    ]);
  });

  it('produces output that fits the agent-facing contract', () => {
    const result = checkPlan(plan(PLAN_FEASIBLE));
    expect(
      V.checkPlanOutput.check({
        plan_id: 'plan_test000001',
        feasible: result.feasible,
        links: result.links,
        missing_roles: result.missingRoles,
      }),
    ).toBe(true);
  });
});

describe('the failing link the film names', () => {
  const result = checkPlan(plan(PLAN_SLOW_VAN));

  it('is infeasible', () => {
    expect(result.feasible).toBe(false);
  });

  it('fails on exactly one link, so there is one thing to say', () => {
    expect(failedLinks(result)).toHaveLength(1);
  });

  it('names arrival_before_admission with 06:40 required and 07:10 offered', () => {
    const [link] = failedLinks(result);
    expect(link).toMatchObject({
      kind: 'arrival_before_admission',
      ok: false,
      from: 'T4',
      to: 'R17',
      field: 'arrival_before_admission',
      required: '06:40',
      offered: '07:10',
      renegotiate_with: 'transport-a',
      relaxable: true,
    });
  });

  it('names the transport provider, not the respite unit', () => {
    // The admission cut-off is a ward handover; the journey time is a route. Only one of those two
    // organisations can do anything about this.
    expect(failedLinks(result)[0]!.renegotiate_with).toBe('transport-a');
  });

  it('closes when T4 is swapped for T9, which is the whole renegotiation', () => {
    expect(checkPlan(plan(PLAN_FEASIBLE)).feasible).toBe(true);
  });
});

describe('every link kind is exercised by a scenario', () => {
  // A link that has never been seen to fail is a link whose passing means nothing. This table is
  // what makes adding a link kind without a scenario a visible omission rather than dead code.
  for (const { name, plan: spec, expectFailing } of LINK_COVERAGE) {
    it(`${name}: ${expectFailing ?? 'feasible'}`, () => {
      const result = checkPlan(plan(spec as PartRequest[]));
      if (expectFailing === null) {
        expect(result.feasible).toBe(true);
        return;
      }
      expect(result.feasible).toBe(false);
      const kinds = failedLinks(result).map((l) => l.kind);
      expect(kinds).toContain(expectFailing);
    });
  }

  it('covers all five link kinds across the table', () => {
    const covered = new Set(LINK_COVERAGE.map((c) => c.expectFailing).filter(Boolean));
    expect(covered).toEqual(
      new Set([
        'single_area',
        'capability_at_both_ends',
        'arrival_before_admission',
        'cover_continuity',
        'placement_before_deadline',
      ]),
    );
  });
});

describe('link detail', () => {
  it('capability_at_both_ends blames the end that lacks the hoist', () => {
    const result = checkPlan(
      plan([
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
        { role: 'transport', provider_id: 'transport-a', resource_id: 'T2' },
        { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
      ]),
    );
    const [link] = failedLinks(result);
    expect(link).toMatchObject({
      kind: 'capability_at_both_ends',
      offered: 'false at T2',
      renegotiate_with: 'transport-a',
    });
  });

  it('capability_at_both_ends does not fire when the person does not need a hoist', () => {
    const result = checkPlan(
      plan(
        [
          { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
          { role: 'transport', provider_id: 'transport-a', resource_id: 'T2' },
          { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
        ],
        { ...GOLDEN_NEED, hoist_required: false },
      ),
    );
    expect(result.links.some((l) => l.kind === 'capability_at_both_ends')).toBe(false);
    expect(result.feasible).toBe(true);
  });

  it('cover_continuity measures against collection, and blames the care agency', () => {
    const result = checkPlan(
      plan([
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
        { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
        { role: 'cover', provider_id: 'homecare-a', resource_id: 'H7' },
      ]),
    );
    const [link] = failedLinks(result);
    expect(link).toMatchObject({
      kind: 'cover_continuity',
      from: 'H7',
      to: 'T9',
      // Cover ends 05:00; T9 collects at 05:50. Fifty minutes alone.
      required: '>=05:50',
      offered: '05:00',
      renegotiate_with: 'homecare-a',
    });
  });

  it('single_area is not relaxable, because a bed in another town is not a preference', () => {
    const result = checkPlan(
      plan([
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R30' },
        { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
        { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
      ]),
    );
    expect(failedLinks(result)[0]).toMatchObject({ kind: 'single_area', relaxable: false });
  });

  it('placement_before_deadline catches a bed in effect after the surgery', () => {
    const result = checkPlan(
      plan([
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R44' },
        { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
        { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
      ]),
    );
    expect(failedLinks(result)[0]).toMatchObject({
      kind: 'placement_before_deadline',
      required: '<=08:00',
      offered: '09:00',
      renegotiate_with: 'respite-a',
    });
  });
});

describe('inapplicable links contribute nothing', () => {
  it('a placement-only plan reports no transport or cover link', () => {
    const result = checkPlan(
      plan(PLAN_PLACEMENT_ONLY as PartRequest[], {
        ...GOLDEN_NEED,
        support_kinds: ['respite_bed'],
      }),
    );
    const kinds = result.links.map((l) => l.kind);
    expect(kinds).not.toContain('arrival_before_admission');
    expect(kinds).not.toContain('cover_continuity');
    // A green tick that means nothing is worse than silence.
    expect(kinds).toEqual(['single_area', 'placement_before_deadline']);
    expect(result.feasible).toBe(true);
  });

  it('a plan missing a requested role is not feasible, and says which role', () => {
    const result = checkPlan(plan(PLAN_PLACEMENT_ONLY as PartRequest[], GOLDEN_NEED));
    expect(result.feasible).toBe(false);
    expect(result.missingRoles.sort()).toEqual(['cover', 'transport']);
  });
});

describe('determinism', () => {
  it('returns an identical verdict across repeated runs', () => {
    const p = plan(PLAN_SLOW_VAN);
    const runs = Array.from({ length: 20 }, () => JSON.stringify(checkPlan(p)));
    expect(new Set(runs).size).toBe(1);
  });

  it('reports links in a fixed order regardless of the order parts were named', () => {
    const forwards = checkPlan(plan(PLAN_SLOW_VAN)).links.map((l) => l.kind);
    const backwards = checkPlan(plan([...PLAN_SLOW_VAN].reverse() as PartRequest[])).links.map(
      (l) => l.kind,
    );
    expect(backwards).toEqual(forwards);
  });
});

describe('buildPlanParts treats an agent-supplied id as a lookup key, never as facts', () => {
  it('rejects a resource that is not in the validated results', () => {
    const built = buildPlanParts(
      [{ role: 'placement', provider_id: 'respite-a', resource_id: 'R99' }],
      OFFERS,
    );
    expect(built).toEqual({ error: { reason: 'unknown_part', request: expect.anything() } });
  });

  it('rejects a resource claimed under the wrong provider', () => {
    // R17 belongs to respite-a. Asking for it under transport-a must not resolve.
    const built = buildPlanParts(
      [{ role: 'placement', provider_id: 'transport-a', resource_id: 'R17' }],
      OFFERS,
    );
    expect('error' in built && built.error.reason).toBe('unknown_part');
  });

  it('rejects a resource claimed under the wrong role', () => {
    const built = buildPlanParts(
      [{ role: 'transport', provider_id: 'respite-a', resource_id: 'R17' }],
      OFFERS,
    );
    expect('error' in built && built.error.reason).toBe('role_mismatch');
  });

  it('rejects two parts in the same role', () => {
    const built = buildPlanParts(
      [
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
        { role: 'placement', provider_id: 'respite-a', resource_id: 'R21' },
      ],
      OFFERS,
    );
    expect('error' in built && built.error.reason).toBe('duplicate_role');
  });

  it('copies no field from the request into the part', () => {
    const built = buildPlanParts(
      [{ role: 'placement', provider_id: 'respite-a', resource_id: 'R17' }],
      OFFERS,
    );
    expect('parts' in built).toBe(true);
    if ('parts' in built) {
      const part = built.parts[0]!;
      const source = OFFERS.find((o) => o.resource_id === 'R17')!;
      expect(part.capabilities).toEqual(source.capabilities);
      expect(part.window).toEqual(source.window);
      expect(part.admission).toEqual(source.admission);
    }
  });

  it('validates against the internal plan contract', () => {
    expect(V.composedPlan.check(plan(PLAN_FEASIBLE))).toBe(true);
  });
});

describe('alternativesForRole', () => {
  it('offers the other vans, excluding the one already in the plan', () => {
    const alts = alternativesForRole('transport', OFFERS, {
      provider_id: 'transport-a',
      resource_id: 'T4',
    });
    expect(alts.map((a) => a.resource_id).sort()).toEqual(['T2', 'T9']);
  });

  it('never suggests a resource with no units left', () => {
    const soldOut: NormalizedOffer[] = OFFERS.map((o) =>
      o.resource_id === 'T9' ? { ...o, units: 0 } : o,
    );
    const alts = alternativesForRole('transport', soldOut, {
      provider_id: 'transport-a',
      resource_id: 'T4',
    });
    expect(alts.map((a) => a.resource_id)).toEqual(['T2']);
  });
});
