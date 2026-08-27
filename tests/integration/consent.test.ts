/**
 * The human consent gate. Build plan §14, §27.4.
 *
 * Five events race for one Promise — Send, Cancel, the agent's abort, the lease lapsing, and a
 * provider failure — and exactly one may win. These tests run each of them, including two arriving
 * at once, because a single-settlement invariant that has never been made to race is an invariant
 * nobody has checked.
 *
 * The other property under test is the one the gate exists for: the person **edits the payload**,
 * and what reaches the organisation is what they edited, not what the agent proposed.
 */

import { describe, expect, it } from 'vitest';

import { GOLDEN_NEED, PLAN_FEASIBLE } from '@threshold/test-fixtures';
import type {
  CheckPlanOutput,
  FindSupportOutput,
  MakeReferralOutput,
  PlacePlanHoldsOutput,
} from '@threshold/contracts';

import { createTestHub, expectFail, expectOk, type TestHub } from './hub';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROPOSED = {
  person_name: 'Ada Okafor',
  contact_method: 'phone' as const,
  contact_value: '07700 900461',
  preferred_contact_window: 'now' as const,
};

async function held(hub: TestHub): Promise<{ holdId: string; planId: string }> {
  const search = expectOk<FindSupportOutput>(await hub.core.findSupport(GOLDEN_NEED));
  const checked = expectOk<CheckPlanOutput>(
    await hub.core.checkPlan({ search_id: search.search_id, parts: PLAN_FEASIBLE }),
  );
  const leases = expectOk<PlacePlanHoldsOutput>(
    await hub.core.placePlanHolds({ plan_id: checked.plan_id }),
  );
  return {
    holdId: leases.leases.find((l) => l.role === 'placement')!.hold_id,
    planId: checked.plan_id,
  };
}

describe('the consent gate', () => {
  it('leaves the agent genuinely pending until a person acts', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    let settled = false;
    const pending = hub.core
      .makeReferral({ hold_id: holdId, ...PROPOSED })
      .then((r) => {
        settled = true;
        return r;
      });

    await tick();
    // Nothing has resolved, nothing has been sent, and the page says so.
    expect(settled).toBe(false);
    expect(hub.machine.tag()).toBe('CONSENT_PENDING');
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);

    await hub.consent.send();
    expectOk<MakeReferralOutput>(await pending);
    expect(settled).toBe(true);
  });

  it('sends what the person edited, not what the agent proposed', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    hub.consent.edit('person_name', 'Adaeze Okafor');
    hub.consent.edit('contact_method', 'email');
    hub.consent.edit('contact_value', 'adaeze@example.org');
    await hub.consent.send();

    const receipt = expectOk<MakeReferralOutput>(await pending);
    expect(receipt.human_edited.sort()).toEqual([
      'contact_method',
      'contact_value',
      'person_name',
    ]);

    const stored = hub.federation.byId('respite-a').store.referral(receipt.referral_id);
    expect(stored?.fields).toMatchObject({
      person_name: 'Adaeze Okafor',
      contact_method: 'email',
      contact_value: 'adaeze@example.org',
      preferred_contact_window: 'now',
    });
  });

  it('refuses to send a payload the contract would reject, without closing the panel', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    hub.consent.edit('person_name', '   ');
    await hub.consent.send();

    // Still open, with the problem attached to the field rather than announced as a failure.
    expect(hub.consent.isPending()).toBe(true);
    expect(hub.consent.view()?.fieldErrors.person_name).toBeTruthy();
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);

    hub.consent.edit('person_name', 'Ada Okafor');
    await hub.consent.send();
    expectOk<MakeReferralOutput>(await pending);
  });

  it('cancelling sends nothing and keeps the lease', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();
    hub.consent.cancel();

    const failure = expectFail(await pending);
    expect(failure.code).toBe('CONSENT_CANCELLED');
    expect(failure.message).toContain('Nothing was sent');
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);

    // The person said no to sending their details, not to the bed.
    expect(hub.machine.tag()).toBe('HELD');
    expect(hub.store.lease(holdId)).toBeDefined();
    expect(hub.federation.byId('respite-a').store.unitsLeft('R17')).toBe(0);
  });

  it("the agent's own abort closes the panel and sends nothing", async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const controller = new AbortController();
    const pending = hub.core.makeReferral(
      { hold_id: holdId, ...PROPOSED },
      { signal: controller.signal },
    );
    await tick();
    controller.abort();

    expect(expectFail(await pending).code).toBe('EXECUTION_ABORTED');
    expect(hub.consent.isPending()).toBe(false);
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);
    expect(hub.machine.tag()).toBe('HELD');
  });

  it('settles exactly once when Send and Cancel race', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    // Both fire in the same turn. Send is already on the wire, so the cancel cannot win: settling
    // as cancelled would tell the person nothing was sent when the referral had already landed.
    const sending = hub.consent.send();
    hub.consent.cancel();
    hub.consent.abort();
    hub.consent.expire();
    await sending;

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(1);
  });

  it('settles exactly once when Cancel lands first', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    hub.consent.cancel();
    // The panel is gone, so Send has nothing to act on. A second terminal event must not resolve
    // the same Promise twice, and must not send anything after a person has said no.
    await hub.consent.send();

    expect(expectFail(await pending).code).toBe('CONSENT_CANCELLED');
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);
  });

  it('never sends against a lease that lapsed while the panel was open', async () => {
    let clock = 2_000_000;
    const hub = await createTestHub({ ttlSeconds: 30, now: () => clock });
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    // The person took a minute to read the panel.
    clock += 60_000;
    await hub.consent.send();

    const failure = expectFail(await pending);
    expect(failure.code).toBe('HOLD_EXPIRED');
    expect(hub.federation.byId('respite-a').store.snapshot().referrals).toHaveLength(0);
    // The page goes back to where a person can search again, and the dead lease is gone.
    expect(hub.store.lease(holdId)).toBeUndefined();
  });

  it('refuses a second consent flow while one is open', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    // The guard is a state check, not a tool unregistration: unregistering `make_referral` during
    // its own execution is the Chrome 153 in-flight edge, and concurrency is the state machine's
    // job (§13.3).
    const second = expectFail(await hub.core.makeReferral({ hold_id: holdId, ...PROPOSED }));
    expect(second.code).toBe('STATE_CONFLICT');

    hub.consent.cancel();
    await pending;
  });

  it('keeps the panel open when a provider fails for a reason that can be retried', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();

    hub.federation.byId('respite-a').hang = true;
    await hub.consent.send();

    // The values the person just checked are still on screen. Closing the panel would throw them
    // away and make them do it again for a reason that had nothing to do with them.
    expect(hub.consent.isPending()).toBe(true);
    expect(hub.consent.view()?.submitError).toBeTruthy();

    hub.federation.byId('respite-a').hang = false;
    await hub.consent.send();
    expectOk<MakeReferralOutput>(await pending);
  });

  it('keeps no copy of what it sent', async () => {
    const hub = await createTestHub();
    const { holdId } = await held(hub);

    const pending = hub.core.makeReferral({ hold_id: holdId, ...PROPOSED });
    await tick();
    await hub.consent.send();
    const receipt = expectOk<MakeReferralOutput>(await pending);

    // The hub keeps which field names crossed, and nothing else. The phone number now exists at the
    // organisation that needs it and nowhere in the coordinating page.
    const everything = JSON.stringify({
      consent: hub.consent.view(),
      session: hub.store.referral(receipt.referral_id),
      log: hub.log.all(),
    });
    expect(everything).not.toContain('900461');
    expect(everything).not.toContain('Ada Okafor');
    expect(everything).toContain('contact_value');
  });
});
