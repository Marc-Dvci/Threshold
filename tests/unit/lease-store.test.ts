/**
 * Lease semantics. Build plan §27.3, §43.6, Invariants E and F.
 *
 * Time is injected throughout. A concurrency suite that sleeps is a concurrency suite nobody runs,
 * and a twenty-minute TTL tested by waiting twenty minutes is a TTL that never gets tested.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { LeaseStore, type ResourceCapacity } from '@threshold/lease-store';
import { deterministicIdSource } from '@threshold/domain';

const CAPACITY: ResourceCapacity[] = [
  { resource_id: 'R17', units: 1, holdable: true }, // the scarce bed
  { resource_id: 'R21', units: 2, holdable: true },
  { resource_id: 'D01', units: 5, holdable: false }, // a public-directory entry
];

let clock = 1_000_000;
let store: LeaseStore;

function makeStore(capacity: ResourceCapacity[] = CAPACITY): LeaseStore {
  const source = deterministicIdSource();
  return new LeaseStore(capacity, {
    now: () => clock,
    mintId: (prefix) => `${prefix}_${source()}`,
  });
}

const referralFields = {
  person_name: 'A. Carer',
  contact_method: 'phone' as const,
  contact_value: '+44 7700 900123',
  preferred_contact_window: 'morning' as const,
};

beforeEach(() => {
  clock = 1_000_000;
  store = makeStore();
});

// ---------------------------------------------------------------------------

describe('acquisition', () => {
  it('holds a free resource', () => {
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    expect(r.outcome).toBe('held');
    if (r.outcome === 'held') {
      expect(r.lease.expires_at_epoch_ms).toBe(clock + 1_200_000);
      expect(r.lease.status).toBe('active');
    }
  });

  it('refuses a second holder of the last unit, which is Invariant F', () => {
    const a = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    expect(a.outcome).toBe('held');

    // A different session, a different idempotency key, the same bed.
    const b = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_bbbb2222',
    });
    expect(b.outcome).toBe('conflict');
    if (b.outcome === 'conflict') {
      expect(b.heldUntilEpochMs).toBe(clock + 1_200_000);
    }
  });

  it('leaks no identifying information in a conflict', () => {
    store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    const b = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_bbbb2222',
    });
    // The other session's existence is unavoidable; anything about who they are is not.
    expect(Object.keys(b)).toEqual(['outcome', 'heldUntilEpochMs']);
  });

  it('allows a second holder while units remain', () => {
    expect(
      store.acquire({
        resource_id: 'R21',
        requested_ttl_seconds: 600,
        client_request_id: 'req_aaaa1111',
      }).outcome,
    ).toBe('held');
    expect(
      store.acquire({
        resource_id: 'R21',
        requested_ttl_seconds: 600,
        client_request_id: 'req_bbbb2222',
      }).outcome,
    ).toBe('held');
    expect(
      store.acquire({
        resource_id: 'R21',
        requested_ttl_seconds: 600,
        client_request_id: 'req_cccc3333',
      }).outcome,
    ).toBe('conflict');
  });

  it('refuses to hold a resource that is not holdable, which is Invariant K', () => {
    // A public-directory entry. Threshold does not place holds against real organisations.
    const r = store.acquire({
      resource_id: 'D01',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    expect(r.outcome).toBe('not_holdable');
  });

  it('refuses an unknown resource rather than inventing one', () => {
    expect(
      store.acquire({
        resource_id: 'R99',
        requested_ttl_seconds: 1200,
        client_request_id: 'req_aaaa1111',
      }).outcome,
    ).toBe('no_such_resource');
  });

  it('clamps a TTL to the provider ceiling regardless of what was asked', () => {
    const small = new LeaseStore(CAPACITY, { now: () => clock, maxTtlSeconds: 60 });
    const r = small.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    expect(r.outcome).toBe('held');
    if (r.outcome === 'held') expect(r.lease.expires_at_epoch_ms).toBe(clock + 60_000);
  });
});

describe('idempotency', () => {
  it('returns the same lease for a retry with the same key', () => {
    const first = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    const retry = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    expect(retry.outcome).toBe('reused');
    if (first.outcome === 'held' && retry.outcome === 'reused') {
      expect(retry.lease.hold_id).toBe(first.lease.hold_id);
    }
    // And critically: it did not take a second unit.
    expect(store.unitsLeft('R17')).toBe(0);
  });

  it('does not let the same key hold two different resources by accident', () => {
    store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    const other = store.acquire({
      resource_id: 'R21',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    // Same key, different resource: a genuinely new lease, because the key names a (plan, role) and
    // the caller has changed which resource fills that role.
    expect(other.outcome).toBe('held');
  });
});

describe('expiry', () => {
  it('frees the resource once the lease lapses', () => {
    store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 60,
      client_request_id: 'req_aaaa1111',
    });
    expect(store.unitsLeft('R17')).toBe(0);

    clock += 59_000;
    expect(store.unitsLeft('R17')).toBe(0);

    clock += 2_000; // past expiry
    expect(store.unitsLeft('R17')).toBe(1);
    expect(
      store.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 60,
        client_request_id: 'req_bbbb2222',
      }).outcome,
    ).toBe('held');
  });

  it('marks a lapsed lease expired on read, without a sweeper', () => {
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 10,
      client_request_id: 'req_aaaa1111',
    });
    const holdId = r.outcome === 'held' ? r.lease.hold_id : '';
    clock += 11_000;
    expect(store.lease(holdId)?.status).toBe('expired');
  });
});

describe('release', () => {
  it('frees the resource immediately', () => {
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    const holdId = r.outcome === 'held' ? r.lease.hold_id : '';
    expect(store.release(holdId).status).toBe('released');
    expect(store.unitsLeft('R17')).toBe(1);
  });

  it('is idempotent, because compensation may run twice', () => {
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    const holdId = r.outcome === 'held' ? r.lease.hold_id : '';
    expect(store.release(holdId).status).toBe('released');
    expect(store.release(holdId).status).toBe('already_released');
    expect(store.release(holdId).status).toBe('already_released');
  });

  it('reports expired rather than released for a lease that had already lapsed', () => {
    // "We released it" and "it lapsed on its own" are different statements about what happened to a
    // scarce resource, and compensation must not be able to claim credit it has not earned.
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 10,
      client_request_id: 'req_aaaa1111',
    });
    const holdId = r.outcome === 'held' ? r.lease.hold_id : '';
    clock += 11_000;
    expect(store.release(holdId).status).toBe('expired');
  });

  it('reports not_found for an unknown hold, and does not throw', () => {
    expect(store.release('hold_nosuchthing').status).toBe('not_found');
  });
});

describe('conversion to a referral', () => {
  function heldR17(): string {
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_aaaa1111',
    });
    return r.outcome === 'held' ? r.lease.hold_id : '';
  }

  it('accepts a referral against a live lease', () => {
    const holdId = heldR17();
    const result = store.convert({
      hold_id: holdId,
      client_request_id: 'ref_aaaa1111',
      ...referralFields,
    });
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.referral.fields.person_name).toBe('A. Carer');
    }
  });

  it('consumes the unit permanently, so the bed cannot be held again', () => {
    const holdId = heldR17();
    store.convert({ hold_id: holdId, client_request_id: 'ref_aaaa1111', ...referralFields });
    expect(store.unitsLeft('R17')).toBe(0);
    // Even long after the original lease would have lapsed.
    clock += 3_600_000;
    expect(store.unitsLeft('R17')).toBe(0);
    expect(
      store.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 1200,
        client_request_id: 'req_bbbb2222',
      }).outcome,
    ).toBe('conflict');
  });

  it('refuses a referral against an expired lease, which is the consent-gate control', () => {
    // The person took four minutes to read the panel and the lease lapsed. No referral is sent.
    const r = store.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 60,
      client_request_id: 'req_aaaa1111',
    });
    const holdId = r.outcome === 'held' ? r.lease.hold_id : '';
    clock += 61_000;
    const result = store.convert({
      hold_id: holdId,
      client_request_id: 'ref_aaaa1111',
      ...referralFields,
    });
    expect(result.outcome).toBe('hold_expired');
    expect(store.snapshot().referrals).toHaveLength(0);
  });

  it('refuses a referral against a released lease', () => {
    const holdId = heldR17();
    store.release(holdId);
    expect(
      store.convert({ hold_id: holdId, client_request_id: 'ref_aaaa1111', ...referralFields })
        .outcome,
    ).toBe('hold_released');
  });

  it('refuses a referral against an unknown lease', () => {
    expect(
      store.convert({
        hold_id: 'hold_nosuchthing',
        client_request_id: 'ref_aaaa1111',
        ...referralFields,
      }).outcome,
    ).toBe('hold_not_found');
  });

  it('is idempotent by request id, so a retry does not refer one person twice', () => {
    const holdId = heldR17();
    const first = store.convert({
      hold_id: holdId,
      client_request_id: 'ref_aaaa1111',
      ...referralFields,
    });
    const retry = store.convert({
      hold_id: holdId,
      client_request_id: 'ref_aaaa1111',
      ...referralFields,
    });
    expect(retry.outcome).toBe('duplicate');
    if (first.outcome === 'accepted' && retry.outcome === 'duplicate') {
      expect(retry.referral.referral_id).toBe(first.referral.referral_id);
    }
    expect(store.snapshot().referrals).toHaveLength(1);
  });

  it('reports a second referral against one lease as a duplicate rather than accepting it', () => {
    const holdId = heldR17();
    store.convert({ hold_id: holdId, client_request_id: 'ref_aaaa1111', ...referralFields });
    const second = store.convert({
      hold_id: holdId,
      client_request_id: 'ref_bbbb2222',
      ...referralFields,
    });
    expect(second.outcome).toBe('duplicate');
    expect(store.snapshot().referrals).toHaveLength(1);
  });

  it('a converted lease reports converted, not released, on release', () => {
    const holdId = heldR17();
    store.convert({ hold_id: holdId, client_request_id: 'ref_aaaa1111', ...referralFields });
    expect(store.release(holdId).status).toBe('converted');
  });
});

describe('the two-session collision, as the demo plays it', () => {
  it('session B cannot take the bed session A holds', () => {
    const a = makeStore(CAPACITY);
    // One store, because one organisation. Two sessions are two callers, not two inventories, and
    // that is exactly why the store cannot live in the page.
    const held = a.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_sessionA',
    });
    expect(held.outcome).toBe('held');

    const blocked = a.acquire({
      resource_id: 'R17',
      requested_ttl_seconds: 1200,
      client_request_id: 'req_sessionB',
    });
    expect(blocked.outcome).toBe('conflict');

    // A releases; B can now take it. The scarcity is honoured in both directions.
    if (held.outcome === 'held') a.release(held.lease.hold_id);
    expect(
      a.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 1200,
        client_request_id: 'req_sessionB',
      }).outcome,
    ).toBe('held');
  });

  it('survives a burst of simultaneous acquirers with exactly one winner', () => {
    // Whatever the interleaving, the invariant is one holder. `acquire` is synchronous with no await
    // in its critical section, so on a single-threaded runtime this is a guarantee rather than a
    // hope; this test is what stops someone making it async later.
    const winners = Array.from({ length: 50 }, (_, i) =>
      store.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 1200,
        client_request_id: `req_burst${String(i).padStart(4, '0')}`,
      }),
    ).filter((r) => r.outcome === 'held');
    expect(winners).toHaveLength(1);
    expect(store.unitsLeft('R17')).toBe(0);
  });
});

describe('reset', () => {
  it('restores deterministic state for the next take', () => {
    const holdId = (() => {
      const r = store.acquire({
        resource_id: 'R17',
        requested_ttl_seconds: 1200,
        client_request_id: 'req_aaaa1111',
      });
      return r.outcome === 'held' ? r.lease.hold_id : '';
    })();
    store.convert({ hold_id: holdId, client_request_id: 'ref_aaaa1111', ...referralFields });
    expect(store.snapshot().referrals).toHaveLength(1);

    store.reset(CAPACITY);

    expect(store.snapshot().referrals).toHaveLength(0);
    expect(store.snapshot().leases).toHaveLength(0);
    expect(store.unitsLeft('R17')).toBe(1);
  });
});
