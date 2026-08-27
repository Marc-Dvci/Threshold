/**
 * Multi-provider lease orchestration and compensating release. Build plan §43.6.
 *
 * Every assertion about what was released is made **at the organisation**, by reading its own lease
 * store, not by reading hub state. That distinction is the whole test suite: a hub that believes it
 * released a bed and an organisation that still has the bed held are exactly the failure this design
 * exists to make impossible, and a test that asked the hub whether it had tidied up would agree with
 * the bug.
 */

import { describe, expect, it } from 'vitest';

import { GOLDEN_NEED, PLAN_FEASIBLE } from '@threshold/test-fixtures';
import type {
  CheckPlanOutput,
  FindSupportOutput,
  OrchestrationFailure,
  PlacePlanHoldsOutput,
  ReleasePlanOutput,
} from '@threshold/contracts';

import { createTestHub, expectFail, expectOk, type TestHub } from './hub';

/** Search, compose the feasible plan, and stop just before taking any lease. */
async function composed(hub: TestHub): Promise<{ planId: string; searchId: string }> {
  const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));
  const checked = expectOk<CheckPlanOutput>(
    await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_FEASIBLE }),
  );
  expect(checked.feasible).toBe(true);
  return { planId: checked.plan_id, searchId: search.search_id };
}

describe('lease orchestration across three organisations', () => {
  it('takes the scarcest leg first', async () => {
    const hub = await createTestHub();
    const { planId } = await composed(hub);
    const held = expectOk<PlacePlanHoldsOutput>(await hub.core.placePlanHolds({ plan_id: planId }));

    // R17 and T9 have one unit each; H3 has two. Scarcest first, ties on role name.
    expect(held.leases.map((l) => l.resource_id)).toEqual(['R17', 'T9', 'H3']);
  });

  it('releases everything already held when a leg is refused', async () => {
    // Two independent sessions against one federation, racing for one van. The order is the whole
    // point and it is the order that actually happens: both sessions see T9 available, and only one
    // of them can have it. A rival that took the van *before* the search would not be a race at all
    // — the van would simply not be in the results.
    const second = await createTestHub();
    const first = await createTestHub({ federation: second.federation });

    const { planId } = await composed(second);

    const rivalSearch = expectOk<FindSupportOutput>(await first.core.findSupport(GOLDEN_NEED));
    expectOk(await first.core.placeHold({ search_id: rivalSearch.search_id, match_id: 'T9' }));

    const failure = expectFail(await second.core.placePlanHolds({ plan_id: planId }));
    const data = failure.data as OrchestrationFailure;

    expect(failure.code).toBe('LEASE_ORCHESTRATION_FAILED');
    expect(data.failed_role).toBe('transport');
    expect(data.failed_reason).toBe('HOLD_CONFLICT');
    expect(data.compensation_complete).toBe(true);
    expect(data.compensation.map((c) => c.resource_id)).toEqual(['R17']);
    expect(data.compensation[0]?.status).toBe('released');

    // Verified at the organisation, not in the hub: the bed is back on the market.
    expect(second.federation.byId('respite-a').store.unitsLeft('R17')).toBe(1);

    // Not a partial success. Nothing is reported as held, and the page is back where a person can
    // choose differently. COMPENSATING is not a state the product can get stuck in.
    expect(second.machine.tag()).toBe('SEARCHED');
    expect(second.trace).toContain('COMPENSATING');
    expect(second.store.allLeases()).toHaveLength(0);
  });

  it('unwinds a third-leg failure too, in reverse acquisition order', async () => {
    const hub = await createTestHub();
    const { planId } = await composed(hub);

    // Both units of the overnight cover go, after this session has already composed its plan around
    // one of them, so the leg that fails is the last one acquired.
    const homecare = hub.federation.byId('homecare-a').store;
    homecare.acquire({ resource_id: 'H3', requested_ttl_seconds: 600, client_request_id: 'req_rivalaa' });
    homecare.acquire({ resource_id: 'H3', requested_ttl_seconds: 600, client_request_id: 'req_rivalbb' });
    const failure = expectFail(await hub.core.placePlanHolds({ plan_id: planId }));
    const data = failure.data as OrchestrationFailure;

    expect(data.failed_role).toBe('cover');
    // Reverse acquisition order: the transport leg taken second is freed first, so the scarcest
    // resource — the bed — is held by a dead plan for the shortest possible time.
    expect(data.compensation.map((c) => c.resource_id)).toEqual(['T9', 'R17']);
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(1);
    expect(hub.federation.byId('transport-a').store.unitsLeft('T9')).toBe(1);
  });

  it('releasing a plan twice releases nothing the second time', async () => {
    const hub = await createTestHub();
    const { planId } = await composed(hub);
    expectOk<PlacePlanHoldsOutput>(await hub.core.placePlanHolds({ plan_id: planId }));

    const first = expectOk<ReleasePlanOutput>(await hub.core.releasePlan({ plan_id: planId }));
    expect(first.complete).toBe(true);
    expect(first.released.map((r) => r.status)).toEqual(['released', 'released', 'released']);

    // Nothing is held, so the page is back in SEARCHED and `release_plan` is not registered any
    // more. An agent holding a stale tool list and calling it again is told where the page is.
    expect(hub.machine.tag()).toBe('SEARCHED');
    expect(hub.machine.desiredTools()).not.toContain('release_plan');
    expect(expectFail(await hub.core.releasePlan({ plan_id: planId })).code).toBe('STATE_CONFLICT');

    // The idempotency itself lives in the orchestrator, which is where compensation calls it from
    // and where it has to hold: unwinding a plan twice must release nothing the second time.
    const again = await hub.orchestrator.releasePlan(planId);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.released).toHaveLength(0);
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(1);
  });

  it('reports a lease it could not release as unreachable, and still reaches a terminal state', async () => {
    const hub = await createTestHub();
    const { planId } = await composed(hub);

    // The respite unit goes offline the moment the transport leg is asked for, so its lease cannot
    // be released during the unwind. This happens in production and the honest answer is not
    // "released".
    hub.federation.byId('transport-a').onCall = () => {
      hub.federation.byId('respite-a').online = false;
    };
    hub.federation.byId('transport-a').store.acquire({
      resource_id: 'T9',
      requested_ttl_seconds: 600,
      client_request_id: 'req_rival02',
    });

    const failure = expectFail(await hub.core.placePlanHolds({ plan_id: planId }));
    const data = failure.data as OrchestrationFailure;

    expect(failure.code).toBe('COMPENSATION_INCOMPLETE');
    expect(data.compensation_complete).toBe(false);
    expect(data.compensation).toEqual([
      expect.objectContaining({ resource_id: 'R17', status: 'unreachable' }),
    ]);
    // The user-facing message says what will happen next rather than that something went wrong.
    expect(failure.message).toContain('lapse on its own');
    expect(hub.machine.tag()).toBe('SEARCHED');
  });

  it('reports a lapsed lease as expired rather than released', async () => {
    let clock = 1_000_000;
    const hub = await createTestHub({ ttlSeconds: 2, now: () => clock });
    const { planId } = await composed(hub);

    // The bed's two-second lease runs out while the van is being asked for, and the van's
    // organisation drops off the network in the same moment. A rival lease would not do here: the
    // provider clamps every TTL to two seconds in this test, so the rival's hold would lapse as well
    // and the conflict would evaporate along with it.
    hub.federation.byId('transport-a').onCall = (tool) => {
      if (tool !== 'hold') return;
      clock += 5000;
      hub.federation.byId('transport-a').online = false;
    };

    const failure = expectFail(await hub.core.placePlanHolds({ plan_id: planId }));
    const data = failure.data as OrchestrationFailure;

    expect(data.compensation).toEqual([
      expect.objectContaining({ resource_id: 'R17', status: 'expired' }),
    ]);
    // "We released it" and "it lapsed on its own" are different statements about a scarce resource,
    // and collapsing them would let a plan take credit for tidying up after itself when it did not.
    expect(data.compensation_complete).toBe(true);
  });

  it('is idempotent: retrying a plan returns the same leases and acquires nothing new', async () => {
    const hub = await createTestHub();
    const { planId } = await composed(hub);

    const first = expectOk<PlacePlanHoldsOutput>(await hub.core.placePlanHolds({ plan_id: planId }));
    // Straight to the orchestrator: the state machine would refuse a second `place_plan_holds`, and
    // the property under test is the idempotency key, not the state guard.
    const again = await hub.orchestrator.placePlanHolds(planId);

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.leases.map((l) => l.hold_id)).toEqual(first.leases.map((l) => l.hold_id));
    // Nothing extra was taken: one unit of the bed, still one lease.
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(0);
    expect(hub.federation.byId('respite-a').store.snapshot().leases).toHaveLength(1);
  });

  it('refuses to lease a plan that is not feasible', async () => {
    const hub = await createTestHub();
    const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));
    const checked = expectOk<CheckPlanOutput>(
      await hub.core.checkPlan({
        search_id: search.search_id,
        parts: [
          { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
          { role: 'transport', provider_id: 'transport-a', resource_id: 'T4' },
          { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
        ],
      }),
    );
    expect(checked.feasible).toBe(false);

    // The tool is not registered in SEARCHED at all, so the agent cannot see it. Calling it anyway
    // — a host agent may hold a stale list — is refused with the state named.
    const failure = expectFail(await hub.core.placePlanHolds({ plan_id: checked.plan_id }));
    expect(failure.code).toBe('STATE_CONFLICT');
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(1);
  });
});
