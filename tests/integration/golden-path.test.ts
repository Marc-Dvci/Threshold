/**
 * The golden path, end to end, over real providers. Build plan §27.6, §31.2.
 *
 * This is the film as a test. Every number the narration says out loud is asserted here, so if a
 * seed value is edited the test fails rather than the recording quietly describing something that no
 * longer happens.
 *
 *   the carer's agent asks once
 *   three organisations answer
 *   the obvious combination does not fit: the bed admits until 06:40, that van arrives at 07:10
 *   the hub names which organisation to go back to
 *   a different van closes the plan
 *   three leases, at three organisations, taken scarcest first
 *   one panel, four fields, edited by the person
 *   one referral
 */

import { describe, expect, it } from 'vitest';

import {
  GOLDEN_NEED,
  PLAN_FEASIBLE,
  PLAN_SLOW_VAN,
} from '@threshold/test-fixtures';
import type {
  CheckPlanOutput,
  ExplainGapOutput,
  FindSupportOutput,
  GetPlanOutput,
  MakeReferralOutput,
  PlacePlanHoldsOutput,
} from '@threshold/contracts';

import { createTestHub, expectFail, expectOk } from './hub';

/** Let the pending consent panel open before a test acts on it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the golden path', () => {
  it('asks once and three organisations answer', async () => {
    const hub = await createTestHub();
    const out = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));

    expect(out.providers_checked.map((p) => p.provider_id).sort()).toEqual([
      'homecare-a',
      'respite-a',
      'transport-a',
    ]);
    expect(out.providers_checked.every((p) => p.state === 'ok')).toBe(true);

    // R17, R44, T9, T4, H3, H7 all satisfy every stated requirement on their own. That T4 is an
    // exact match here is the whole argument for composition: it is a perfectly good van that
    // cannot be used, and only the link between it and R17 knows that.
    const ids = out.exact_matches.map((m) => m.resource_id).sort();
    expect(ids).toEqual(['H3', 'H7', 'R17', 'R44', 'T4', 'T9']);

    // R21 has no hoist, T2 has no hoist. One requirement each, both relaxable.
    expect(out.near_misses.map((m) => m.resource_id).sort()).toEqual(['R21', 'T2']);
    expect(out.near_misses.every((m) => m.failed_count === 1 && m.relaxable)).toBe(true);

    // Every role the person asked about has something usable, so a plan is possible.
    expect(out.roles_with_no_offer).toBeUndefined();
    expect(hub.machine.tag()).toBe('SEARCHED');
  });

  it('finds the one link that fails, and names who to go back to', async () => {
    const hub = await createTestHub();
    const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));

    const checked = expectOk<CheckPlanOutput>(
      await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_SLOW_VAN }),
    );

    expect(checked.feasible).toBe(false);
    const failing = checked.links.filter((l) => !l.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      kind: 'arrival_before_admission',
      required: '06:40',
      offered: '07:10',
      renegotiate_with: 'transport-a',
      from: 'T4',
      to: 'R17',
    });

    // An infeasible plan does not advance the state, so `place_plan_holds` is never registered and
    // an agent cannot take leases against a plan that cannot happen.
    expect(hub.machine.tag()).toBe('SEARCHED');
    expect(hub.machine.desiredTools()).not.toContain('place_plan_holds');

    const gap = expectOk<ExplainGapOutput>(
      await hub.core.explainGap({ search_id: search.search_id, plan_id: checked.plan_id }),
    );
    expect(gap.scope).toBe('plan');
    expect(gap.failed_links?.[0]?.renegotiate_with).toBe('transport-a');
    // Alternatives are offered for the transport leg — the one worth a conversation — so the agent
    // can re-check without a second fan-out against organisations that did nothing wrong.
    expect(gap.alternatives_same_role?.map((a) => a.resource_id)).toContain('T9');
  });

  it('closes the plan with a different van and registers the next step', async () => {
    const hub = await createTestHub();
    const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));

    const checked = expectOk<CheckPlanOutput>(
      await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_FEASIBLE }),
    );
    expect(checked.feasible).toBe(true);
    expect(checked.links.every((l) => l.ok)).toBe(true);
    expect(hub.machine.tag()).toBe('PLAN_COMPOSED');
    expect(hub.machine.desiredTools()).toContain('place_plan_holds');
  });

  it('leases three organisations scarcest first, then refers', async () => {
    const hub = await createTestHub();
    const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));
    const checked = expectOk<CheckPlanOutput>(
      await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_FEASIBLE }),
    );

    const held = expectOk<PlacePlanHoldsOutput>(
      await hub.core.placePlanHolds({ plan_id: checked.plan_id }),
    );
    expect(held.status).toBe('all_held');

    // R17 and T9 have one unit each, H3 has two. Ties break on role name, so the placement is taken
    // first: losing the scarcest leg late wastes the most work.
    expect(held.leases.map((l) => l.resource_id)).toEqual(['R17', 'T9', 'H3']);
    expect(new Set(held.leases.map((l) => l.provider_id)).size).toBe(3);

    // The leases are real at each organisation, checked at the organisation rather than in the hub.
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(0);
    expect(hub.federation.byId('transport-a').store.unitsLeft('T9')).toBe(0);
    expect(hub.machine.tag()).toBe('HELD');
    expect(hub.trace).toContain('PARTIALLY_HELD');

    const placement = held.leases.find((l) => l.role === 'placement')!;
    const pending = hub.core.makeReferral({
      hold_id: placement.hold_id,
      person_name: 'Ada Okafor',
      contact_method: 'phone',
      contact_value: '07700 900461',
      preferred_contact_window: 'now',
    });

    await tick();
    expect(hub.machine.tag()).toBe('CONSENT_PENDING');
    expect(hub.consent.view()?.request.providerName).toBe('Meadowbank Respite Unit');

    // The differentiator: the person changes the payload before it goes.
    hub.consent.edit('contact_value', '07700 900123');
    await hub.consent.send();

    const referral = expectOk<MakeReferralOutput>(await pending);
    expect(referral.human_edited).toEqual(['contact_value']);
    expect(referral.fields_sent).toEqual([
      'person_name',
      'contact_method',
      'contact_value',
      'preferred_contact_window',
    ]);
    expect(referral.next_step).toBe('provider_will_call');
    expect(hub.machine.tag()).toBe('REFERRED');

    // The organisation received the corrected number, not the proposed one.
    const record = hub.federation.byId('respite-a').store.referral(referral.referral_id);
    expect(record?.fields.contact_value).toBe('07700 900123');

    const plan = expectOk<GetPlanOutput>(
      await hub.core.getPlan({ referral_id: referral.referral_id }),
    );
    expect(plan.status).toBe('referred');
    expect(plan.parts.map((p) => p.resource_id).sort()).toEqual(['H3', 'R17', 'T9']);
  });

  it('never lets the boundary log carry a value', async () => {
    const hub = await createTestHub();
    const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));
    const checked = expectOk<CheckPlanOutput>(
      await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_FEASIBLE }),
    );
    const held = expectOk<PlacePlanHoldsOutput>(
      await hub.core.placePlanHolds({ plan_id: checked.plan_id }),
    );

    const pending = hub.core.makeReferral({
      hold_id: held.leases[0]!.hold_id,
      person_name: 'Ada Okafor',
      contact_method: 'phone',
      contact_value: '07700 900461',
      preferred_contact_window: 'morning',
    });
    await tick();
    await hub.consent.send();
    await pending;

    const printed = JSON.stringify(hub.log.all());
    expect(printed).not.toContain('Ada Okafor');
    expect(printed).not.toContain('900461');
    // What it does record is that four named fields crossed.
    expect(printed).toContain('identifying referral transmitted');
    expect(printed).toContain('contact_value');
  });

  it('refuses a step that is not available yet, and says where the page is', async () => {
    const hub = await createTestHub();
    const failure = expectFail(await hub.core.getPlan({ referral_id: 'ref_aaaaaaaa' }));
    expect(failure.code).toBe('STATE_CONFLICT');
    expect(failure.message).toContain('READY');
    expect(failure.message).toContain('REFERRED');
  });
});
