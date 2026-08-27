/**
 * The hub's session store. Build plan §16.2.
 *
 * The hub has no database and no backend. Everything it knows lives here, in memory, for the length
 * of one page visit, and that is the architecture rather than a shortcut: the entire privacy claim
 * is that the coordinating page holds nothing, and a page that holds nothing is a page with no
 * persistence layer to audit.
 *
 * What this store *is* for is the rule stated in §9.3 and restated in §42.2, which is the single
 * most important security property in the hub after the firewall:
 *
 *   **An identifier from a model is a lookup key, never a source of facts.**
 *
 * The agent names `(provider_id, resource_id)`. Every field of every offer, plan part and lease is
 * then read from what a provider actually said and what Ajv actually accepted. Nothing an agent
 * sends is ever copied into a plan, a hold or a referral except the address it used to point at
 * something. That is why the search results are kept at all.
 */

import type {
  ComposedPlan,
  Instant,
  NeedProfile,
  PlanPartRole,
  ProviderId,
  ProviderStatus,
} from '@threshold/contracts';
import type { CheckPlanResult, NormalizedOffer } from '@threshold/domain';

/** One fan-out and everything that survived the firewall. */
export type SearchSession = {
  search_id: string;
  need: NeedProfile;
  /** Every validated offer, matching or not. `explain_gap` needs the ones that did not match. */
  offers: readonly NormalizedOffer[];
  /** Offers that satisfy every stated requirement, ranked. */
  exact: readonly NormalizedOffer[];
  /** Offers failing one or two relaxable requirements, ranked. */
  nearMisses: readonly NormalizedOffer[];
  providerStatuses: readonly ProviderStatus[];
  createdAtEpochMs: number;
};

export type PlanRecord = {
  plan_id: string;
  search_id: string;
  plan: ComposedPlan;
  result: CheckPlanResult;
};

/**
 * A lease the hub is currently responsible for.
 *
 * `expires_at_epoch_ms` is the provider's number, carried unchanged. The hub renders a countdown
 * from it and never recomputes it (Invariant E): the organisation owns the clock that decides when
 * its bed is free again, and a hub that did its own arithmetic would eventually disagree with the
 * only party whose opinion counts.
 */
export type ActiveLease = {
  role: PlanPartRole;
  provider_id: ProviderId;
  resource_id: string;
  hold_id: string;
  expires_at_epoch_ms: number;
  /** Set when the lease was acquired as part of a composed plan. */
  plan_id?: string;
  search_id: string;
};

export type ReferralReceipt = {
  referral_id: string;
  provider_id: ProviderId;
  hold_id: string;
  resource_id: string;
  /** Which of the four fields crossed. Names only. */
  fields_sent: readonly string[];
  human_edited: readonly string[];
  next_step?: 'provider_will_call' | 'provider_will_email' | 'arrive_at_stated_time';
  /** The plan the referred lease belonged to, if any, so `get_plan` can show the whole thing. */
  plan_id?: string;
  parts: ReadonlyArray<{
    role: PlanPartRole;
    provider_id: ProviderId;
    resource_id: string;
    window: { from: Instant; to: Instant };
  }>;
};

export class SessionStore {
  private searches = new Map<string, SearchSession>();
  private plans = new Map<string, PlanRecord>();
  private leases = new Map<string, ActiveLease>();
  private referrals = new Map<string, ReferralReceipt>();
  private latestSearchId: string | null = null;

  putSearch(session: SearchSession): void {
    this.searches.set(session.search_id, session);
    this.latestSearchId = session.search_id;
  }

  search(id: string): SearchSession | undefined {
    return this.searches.get(id);
  }

  /** The search a UI panel should be rendering. Tools always address one by id. */
  currentSearch(): SearchSession | undefined {
    return this.latestSearchId ? this.searches.get(this.latestSearchId) : undefined;
  }

  /**
   * Resolve `(provider_id, resource_id)` against validated results.
   *
   * The whole point of the store. Returns `undefined` rather than throwing, because "the agent
   * named something that is not in these results" is an ordinary answer to give an agent, not an
   * exceptional condition.
   */
  offer(searchId: string, providerId: ProviderId, resourceId: string): NormalizedOffer | undefined {
    return this.searches
      .get(searchId)
      ?.offers.find((o) => o.provider_id === providerId && o.resource_id === resourceId);
  }

  /**
   * Resolve a bare `resource_id` within one search.
   *
   * `place_hold` and the offer form of `explain_gap` address a match by resource id alone, because
   * that is what `find_support` puts in front of the agent and a two-field address would be one more
   * thing for it to get wrong. Ambiguity is possible in principle — two organisations could both
   * name a resource `T4` — so it is resolved rather than assumed: an ambiguous id returns
   * `undefined` and the caller reports MATCH_NOT_FOUND rather than silently leasing the wrong one.
   */
  offerByResource(searchId: string, resourceId: string): NormalizedOffer | undefined {
    const matches = this.searches.get(searchId)?.offers.filter((o) => o.resource_id === resourceId);
    return matches && matches.length === 1 ? matches[0] : undefined;
  }

  putPlan(record: PlanRecord): void {
    this.plans.set(record.plan_id, record);
  }

  plan(id: string): PlanRecord | undefined {
    return this.plans.get(id);
  }

  putLease(lease: ActiveLease): void {
    this.leases.set(lease.hold_id, lease);
  }

  lease(holdId: string): ActiveLease | undefined {
    return this.leases.get(holdId);
  }

  dropLease(holdId: string): void {
    this.leases.delete(holdId);
  }

  /** Leases for one plan, in acquisition order. Compensation walks this in reverse. */
  leasesForPlan(planId: string): ActiveLease[] {
    return [...this.leases.values()].filter((l) => l.plan_id === planId);
  }

  allLeases(): ActiveLease[] {
    return [...this.leases.values()];
  }

  /** Leases the provider clock says are still alive. Expiry is read, never swept. */
  liveLeases(atEpochMs: number): ActiveLease[] {
    return this.allLeases().filter((l) => l.expires_at_epoch_ms > atEpochMs);
  }

  putReferral(receipt: ReferralReceipt): void {
    this.referrals.set(receipt.referral_id, receipt);
  }

  referral(id: string): ReferralReceipt | undefined {
    return this.referrals.get(id);
  }

  /**
   * Forget everything.
   *
   * Used by the demo reset (§29) and on teardown. Not a nicety: a reset that leaves a stale lease
   * behind is a reset that makes the *next* take fail with a conflict nobody can explain.
   */
  clear(): void {
    this.searches.clear();
    this.plans.clear();
    this.leases.clear();
    this.referrals.clear();
    this.latestSearchId = null;
  }
}
