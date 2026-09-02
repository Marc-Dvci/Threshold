/**
 * The authoritative lease store. Build plan §15, Invariants E and F.
 *
 * **Why this is not in the page.** A hold kept in the provider page's memory gives every browser tab
 * its own copy, so two tabs could each "hold" the last bed and the collision demo would be theatre.
 * The provider's own server is the authority on whether it holds something, because in the real
 * world the organisation is. The browser renders a countdown from a number the provider gave it and
 * never treats its own arithmetic as the truth.
 *
 * **What makes acquisition atomic.** JavaScript's single-threaded event loop. `acquire` performs its
 * read-modify-write with no `await` inside the critical section, so no other request can interleave.
 * That is a genuine guarantee within one process and it is stated rather than assumed: see
 * `assertNoAwaitInCriticalSection` in the tests. Running more than one instance of a provider would
 * break it, and the fix there is a Durable Object or a row lock, not a mutex in this file. Recorded
 * in `docs/THREAT_MODEL.md` rather than left as a surprise.
 *
 * **Why `expired` is distinct from `released`.** Compensation has to be able to report that a lease
 * it tried to release had already lapsed. "We released it" and "it lapsed on its own" are different
 * statements about what happened to a scarce resource, and collapsing them would let a plan claim
 * credit for tidying up after itself when it did not.
 */

import type { ProviderReferralInput } from '@threshold/contracts';

export type LeaseStatus = 'active' | 'released' | 'converted' | 'expired';

export type LeaseRecord = {
  hold_id: string;
  resource_id: string;
  client_request_id: string;
  created_at_epoch_ms: number;
  expires_at_epoch_ms: number;
  status: LeaseStatus;
};

export type ReferralRecord = {
  referral_id: string;
  hold_id: string;
  resource_id: string;
  received_at_epoch_ms: number;
  /** The four fields, as received. Held by the provider because it now has a duty of care to them. */
  fields: Omit<ProviderReferralInput, 'hold_id' | 'client_request_id'>;
  client_request_id: string;
};

export type AcquireResult =
  | { outcome: 'held'; lease: LeaseRecord }
  | { outcome: 'reused'; lease: LeaseRecord }
  | { outcome: 'conflict'; heldUntilEpochMs: number }
  | { outcome: 'no_such_resource' }
  | { outcome: 'not_holdable' };

export type ReleaseResult = {
  status: 'released' | 'already_released' | 'expired' | 'converted' | 'not_found';
};

export type ConvertResult =
  | { outcome: 'accepted'; referral: ReferralRecord }
  | { outcome: 'duplicate'; referral: ReferralRecord }
  | { outcome: 'hold_expired' }
  | { outcome: 'hold_not_found' }
  | { outcome: 'hold_released' };

export type ResourceCapacity = {
  resource_id: string;
  units: number;
  holdable: boolean;
};

export type LeaseStoreOptions = {
  /** The provider's ceiling, applied regardless of what a caller asks for. */
  maxTtlSeconds?: number;
  /** Injectable so tests can advance time without sleeping. Never used for domain instants. */
  now?: () => number;
  /** Injectable so the recording rig gets stable identifiers. */
  mintId?: (prefix: 'hold' | 'ref') => string;
};

let fallbackCounter = 0;

/**
 * A per-process salt, and it is the whole point of this function.
 *
 * Every organisation runs its own store in its own process, and a bare counter starts at one in all
 * of them — so three independent organisations each hand out `hold_000001` for three completely
 * different resources. Those ids meet in the hub, which holds one lease per id, and the collision is
 * silent: leases overwrite each other, a plan that took three holds reports one, the two it lost can
 * no longer be released, and a referral aimed at the respite bed is delivered to whichever
 * organisation wrote that key last. Nothing errors anywhere along that path.
 *
 * An id minted by one party and pooled with another party's must therefore carry something the other
 * party cannot also produce. Six random characters is that, and the counter is kept beside it so the
 * ids stay readable in a log. Stays inside the opaque-id contract: `^[a-z]{1,10}_[A-Za-z0-9]{6,24}$`.
 */
const processSalt = Array.from({ length: 6 }, () =>
  'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)),
).join('');

const defaultMint = (prefix: 'hold' | 'ref'): string => {
  fallbackCounter += 1;
  return `${prefix}_${processSalt}${fallbackCounter.toString(36).padStart(4, '0')}`;
};

export class LeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly referrals = new Map<string, ReferralRecord>();
  /** resource_id -> capacity. The provider's own inventory truth. */
  private readonly capacity = new Map<string, ResourceCapacity>();
  private readonly maxTtlSeconds: number;
  private readonly now: () => number;
  private readonly mintId: (prefix: 'hold' | 'ref') => string;

  constructor(resources: readonly ResourceCapacity[], options: LeaseStoreOptions = {}) {
    for (const r of resources) this.capacity.set(r.resource_id, { ...r });
    this.maxTtlSeconds = options.maxTtlSeconds ?? 1200;
    this.now = options.now ?? (() => Date.now());
    this.mintId = options.mintId ?? defaultMint;
  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  /**
   * An expired lease is treated as absent.
   *
   * Lazy rather than swept by a timer, on purpose. A timer is a second source of truth about when a
   * lease ended, and it drifts, and it does not run while a serverless instance is asleep. Deciding
   * at read time means the answer is always computed from the clock and the record.
   */
  private isLive(lease: LeaseRecord, at: number): boolean {
    return lease.status === 'active' && lease.expires_at_epoch_ms > at;
  }

  /** Live leases against a resource, after expiry. */
  private liveCount(resourceId: string, at: number): number {
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.resource_id === resourceId && this.isLive(lease, at)) n += 1;
    }
    return n;
  }

  /** Leases converted into referrals consume a unit permanently. */
  private convertedCount(resourceId: string): number {
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.resource_id === resourceId && lease.status === 'converted') n += 1;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Acquisition
  // -------------------------------------------------------------------------

  /**
   * Acquire a lease.
   *
   * The critical section runs from the first read to the `set`, with **no `await` inside it**. That
   * is what makes this atomic on a single-threaded runtime, and it is the reason this method is
   * synchronous: an `async` signature would invite a future contributor to await something in the
   * middle and silently destroy the guarantee.
   */
  acquire(input: {
    resource_id: string;
    requested_ttl_seconds: number;
    client_request_id: string;
  }): AcquireResult {
    const at = this.now();

    const resource = this.capacity.get(input.resource_id);
    if (!resource) return { outcome: 'no_such_resource' };
    if (!resource.holdable) return { outcome: 'not_holdable' };

    // Idempotency first. A retry after an ambiguous network result must return the *same* lease, or
    // the retry takes a second unit of a scarce resource away from somebody for no reason.
    for (const lease of this.leases.values()) {
      if (
        lease.client_request_id === input.client_request_id &&
        lease.resource_id === input.resource_id
      ) {
        if (this.isLive(lease, at)) return { outcome: 'reused', lease };
        // A lapsed lease under the same key does not block a fresh acquisition; fall through.
        break;
      }
    }

    const taken = this.liveCount(input.resource_id, at) + this.convertedCount(input.resource_id);
    if (taken >= resource.units) {
      let soonest = Number.POSITIVE_INFINITY;
      for (const lease of this.leases.values()) {
        if (lease.resource_id === input.resource_id && this.isLive(lease, at)) {
          soonest = Math.min(soonest, lease.expires_at_epoch_ms);
        }
      }
      return {
        outcome: 'conflict',
        // When every unit is converted rather than held there is no expiry to report; `at` is the
        // honest answer, because nothing is going to free up.
        heldUntilEpochMs: Number.isFinite(soonest) ? soonest : at,
      };
    }

    const ttl = Math.min(Math.max(1, Math.floor(input.requested_ttl_seconds)), this.maxTtlSeconds);
    const lease: LeaseRecord = {
      hold_id: this.mintId('hold'),
      resource_id: input.resource_id,
      client_request_id: input.client_request_id,
      created_at_epoch_ms: at,
      expires_at_epoch_ms: at + ttl * 1000,
      status: 'active',
    };
    this.leases.set(lease.hold_id, lease);
    return { outcome: 'held', lease };
  }

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  /**
   * Release a lease. Idempotent.
   *
   * Compensation calls this for every lease a failed plan holds, possibly twice, possibly on a lease
   * that has already lapsed. Every one of those is a normal outcome with its own answer, not an
   * error.
   */
  release(holdId: string): ReleaseResult {
    const at = this.now();
    const lease = this.leases.get(holdId);
    if (!lease) return { status: 'not_found' };

    if (lease.status === 'converted') return { status: 'converted' };
    if (lease.status === 'released') return { status: 'already_released' };
    if (lease.status === 'expired' || lease.expires_at_epoch_ms <= at) {
      lease.status = 'expired';
      return { status: 'expired' };
    }
    lease.status = 'released';
    return { status: 'released' };
  }

  // -------------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------------

  /**
   * Turn a lease into a referral.
   *
   * The server re-checks the lease here, and that is not belt-and-braces: it is the control that
   * makes the consent gate meaningful. The hub's countdown is a rendering, the browser's clock is
   * not trustworthy, and the person may have taken four minutes to read the panel. If the lease
   * lapsed while they were reading, no referral is sent (§14.5).
   */
  convert(input: ProviderReferralInput): ConvertResult {
    const at = this.now();
    const lease = this.leases.get(input.hold_id);
    if (!lease) return { outcome: 'hold_not_found' };

    // Idempotency by client_request_id, so a retry after a network ambiguity does not create a
    // second referral for one person.
    for (const referral of this.referrals.values()) {
      if (referral.client_request_id === input.client_request_id) {
        return { outcome: 'duplicate', referral };
      }
    }

    if (lease.status === 'released') return { outcome: 'hold_released' };
    if (lease.status === 'expired' || lease.expires_at_epoch_ms <= at) {
      lease.status = 'expired';
      return { outcome: 'hold_expired' };
    }
    if (lease.status === 'converted') {
      // Converted under a *different* request id: a second referral against one lease.
      const existing = [...this.referrals.values()].find((r) => r.hold_id === lease.hold_id);
      if (existing) return { outcome: 'duplicate', referral: existing };
      return { outcome: 'hold_released' };
    }

    const referral: ReferralRecord = {
      referral_id: this.mintId('ref'),
      hold_id: lease.hold_id,
      resource_id: lease.resource_id,
      received_at_epoch_ms: at,
      client_request_id: input.client_request_id,
      fields: {
        person_name: input.person_name,
        contact_method: input.contact_method,
        contact_value: input.contact_value,
        preferred_contact_window: input.preferred_contact_window,
      },
    };
    lease.status = 'converted';
    this.referrals.set(referral.referral_id, referral);
    return { outcome: 'accepted', referral };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Units still available, after live holds and conversions. Drives `units_left` in search output. */
  unitsLeft(resourceId: string): number {
    const at = this.now();
    const resource = this.capacity.get(resourceId);
    if (!resource) return 0;
    return Math.max(
      0,
      resource.units - this.liveCount(resourceId, at) - this.convertedCount(resourceId),
    );
  }

  lease(holdId: string): LeaseRecord | undefined {
    const lease = this.leases.get(holdId);
    if (lease && lease.status === 'active' && lease.expires_at_epoch_ms <= this.now()) {
      lease.status = 'expired';
    }
    return lease;
  }

  referral(referralId: string): ReferralRecord | undefined {
    return this.referrals.get(referralId);
  }

  /** Everything, for the provider's own page and for the demo reset. Never sent to the hub. */
  snapshot(): {
    leases: LeaseRecord[];
    referrals: ReferralRecord[];
    capacity: ResourceCapacity[];
  } {
    return {
      leases: [...this.leases.values()],
      referrals: [...this.referrals.values()],
      capacity: [...this.capacity.values()],
    };
  }

  /**
   * Restore deterministic state. Build plan §29.
   *
   * A competition demo fails when seeded state is dirty, and "release every hold and delete every
   * referral" needs to be one call that cannot half-succeed.
   */
  reset(resources?: readonly ResourceCapacity[]): void {
    this.leases.clear();
    this.referrals.clear();
    if (resources) {
      this.capacity.clear();
      for (const r of resources) this.capacity.set(r.resource_id, { ...r });
    }
  }
}
