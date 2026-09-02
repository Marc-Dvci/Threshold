/**
 * Hold ids are minted by organisations that do not coordinate.
 *
 * Found on the deployment, from a clean start: all three organisations handed out `hold_000001` for
 * three unrelated resources, because each runs its own store in its own process and a counter starts
 * at one everywhere. Keyed by that string alone, the hub kept **one** of the three leases. A plan
 * that had taken three holds reported one, the other two could never be released, and a referral
 * aimed at the respite bed was delivered to the overnight-care agency instead — with the person's
 * name and telephone number in it. Nothing threw, and the consent panel named the organisation that
 * had won the key, so the page was not even lying; it was answering a different question.
 *
 * Two independent guards, because either alone still leaves a way through:
 *  - ids carry a per-process salt, so independent organisations stop colliding by construction;
 *  - the hub keys leases by `(provider_id, hold_id)` and refuses to guess when an id is ambiguous,
 *    so a provider that collides anyway — by accident or on purpose — cannot evict another's lease
 *    or redirect a referral.
 */

import { describe, expect, it } from 'vitest';

import { SessionStore, type ActiveLease } from '../../apps/hub/src/session/session';
import { LeaseStore } from '@threshold/lease-store';

function lease(providerId: string, resourceId: string, holdId: string): ActiveLease {
  return {
    provider_id: providerId,
    resource_id: resourceId,
    hold_id: holdId,
    role: 'placement',
    search_id: 'search_aaaaaa',
    plan_id: 'plan_aaaaaa',
    expires_at_epoch_ms: Date.now() + 60_000,
  } as ActiveLease;
}

describe('lease identity across organisations', () => {
  it('two organisations issuing the same hold id both keep their lease', () => {
    const store = new SessionStore();
    store.putLease(lease('respite-a', 'R17', 'hold_000001'));
    store.putLease(lease('transport-a', 'T9', 'hold_000001'));
    store.putLease(lease('homecare-a', 'H3', 'hold_000001'));

    // The bug returned 1 here: two organisations' beds silently evicted.
    expect(store.allLeases()).toHaveLength(3);
    expect(store.allLeases().map((l) => l.provider_id).sort()).toEqual([
      'homecare-a',
      'respite-a',
      'transport-a',
    ]);
  });

  it('an ambiguous hold id is refused, not guessed', () => {
    const store = new SessionStore();
    store.putLease(lease('respite-a', 'R17', 'hold_000001'));
    store.putLease(lease('transport-a', 'T9', 'hold_000001'));

    // Refusing costs a person one retry. Guessing sends their name and telephone number to an
    // organisation nobody asked for, and there is no undo for that.
    expect(store.lease('hold_000001')).toBeUndefined();
  });

  it('an unambiguous hold id still resolves, to the right organisation', () => {
    const store = new SessionStore();
    store.putLease(lease('respite-a', 'R17', 'hold_aaaaaa'));
    store.putLease(lease('transport-a', 'T9', 'hold_bbbbbb'));

    expect(store.lease('hold_aaaaaa')?.provider_id).toBe('respite-a');
    expect(store.lease('hold_bbbbbb')?.provider_id).toBe('transport-a');
  });

  it('dropping a lease drops only that organisation’s', () => {
    const store = new SessionStore();
    store.putLease(lease('respite-a', 'R17', 'hold_aaaaaa'));
    store.putLease(lease('transport-a', 'T9', 'hold_bbbbbb'));

    store.dropLease('hold_aaaaaa');
    expect(store.allLeases().map((l) => l.provider_id)).toEqual(['transport-a']);
  });

  it('a minted hold id carries more than a counter, and still fits the contract', () => {
    const store = new LeaseStore([{ resource_id: 'R17', units: 3, holdable: true }]);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const held = store.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 60,
        client_request_id: `req_${i}`,
      });
      const holdId = (held as { lease?: { hold_id?: string } }).lease?.hold_id;
      expect(holdId, `acquire returned ${JSON.stringify(held)}`).toBeTypeOf('string');
      ids.add(holdId!);
      // The id an agent will quote has to survive the opaque-id contract.
      expect(holdId!).toMatch(/^[a-z]{1,10}_[A-Za-z0-9]{6,24}$/);
      // A bare counter is what made three organisations collide.
      expect(holdId!).not.toMatch(/^hold_0*[0-9]{1,6}$/);
    }
    expect(ids.size).toBe(3);
  });
});
