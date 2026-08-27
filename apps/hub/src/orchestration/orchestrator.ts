/**
 * Multi-provider lease orchestration and compensating release. Build plan §43.
 *
 * Three parts of one plan live at three organisations that share no database, no transaction
 * manager and no knowledge of each other. There is no two-phase commit available and there is not
 * going to be one. **Anything that claims atomicity across those origins is lying.**
 *
 * What is available is short provider-authoritative leases with a TTL, sequential acquisition, and
 * compensation. That is a saga, and it is the right shape here for a reason that has nothing to do
 * with elegance: the TTL means the worst case degrades on its own. If this code dies halfway
 * through, every lease it took lapses within twenty minutes without anyone doing anything.
 *
 * Two design positions worth defending out loud, because both look like compromises and neither is:
 *
 *  - **Sequential, not concurrent.** Concurrent acquisition takes leases it is about to throw away.
 *    Against a genuinely scarce humanitarian resource — one bed, one wheelchair van at six in the
 *    morning — that is precisely the antisocial machine-speed behaviour this project exists to argue
 *    against. It is slower on purpose.
 *
 *  - **Scarcest first.** Losing the scarcest leg last wastes the most work and holds the most
 *    contended resource for the longest. Taking it first means a plan that cannot happen finds out
 *    early, and the bed goes back on the market seconds rather than minutes later.
 *
 * And one honesty rule: partial success is **not** reported as success. Telling an agent "two of
 * three held" invites it to tell a person something is reserved when the plan cannot happen. The
 * failure carries the compensation record instead, so the agent can say truthfully that nothing is
 * being held.
 */

import {
  USER_FACING_MESSAGE,
  fail,
  ok,
  type CompensationEntry,
  type ErrorCode,
  type Lease,
  type OrchestrationFailure,
  type PlacePlanHoldsOutput,
  type PlanPart,
  type ReleasePlanOutput,
  type ToolResult,
} from '@threshold/contracts';
import { leaseRequestId } from '@threshold/domain';

import type { BoundaryLog } from '../audit/boundary-log';
import type { ProviderBroker } from '../broker/broker';
import { providerById } from '../broker/registry';
import type { ActiveLease, SessionStore } from '../session/session';

/** The lease TTL the hub always asks for. Providers clamp to their own ceiling regardless. */
export const PLAN_LEASE_TTL_SECONDS = 1200;

export type OrchestratorDeps = {
  broker: ProviderBroker;
  store: SessionStore;
  log: BoundaryLog;
  /** Shorter TTL for tests that need to watch a lease lapse without waiting twenty minutes. */
  ttlSeconds?: number;
  /**
   * Called as each leg lands, so the hub can move to PARTIALLY_HELD and the page can show a
   * countdown starting on a real lease before the next call is even made.
   *
   * The intermediate states are not bookkeeping. A viewer watching the respite countdown start,
   * then the transport leg refuse, then the countdown stop, is watching the one thing a single
   * backend cannot fake. Hiding those states behind a spinner would throw the demonstration away.
   */
  onLeaseAcquired?: (lease: ActiveLease) => void;
  /** Called when acquisition has failed and the unwind is about to begin. */
  onCompensating?: (planId: string) => void;
};

export class LeaseOrchestrator {
  private readonly ttlSeconds: number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.ttlSeconds = deps.ttlSeconds ?? PLAN_LEASE_TTL_SECONDS;
  }

  /**
   * Order a plan's parts scarcest first.
   *
   * Scarcity is read from the *validated search results*, not from the plan, because the plan does
   * not carry unit counts and should not: a plan is a set of addresses into results the hub already
   * checked. Ties break on role name so two runs order identically and a take can be re-recorded.
   */
  private acquisitionOrder(searchId: string, parts: readonly PlanPart[]): PlanPart[] {
    const units = (part: PlanPart): number =>
      this.deps.store.offer(searchId, part.provider_id, part.resource_id)?.units ?? Number.MAX_SAFE_INTEGER;
    return [...parts].sort((a, b) => units(a) - units(b) || a.role.localeCompare(b.role));
  }

  /**
   * Acquire every lease a plan needs, or none.
   *
   * The `client_request_id` is derived from `(plan_id, role)` rather than minted, which is what makes
   * a retry after an ambiguous network result safe: the provider recognises the key and returns the
   * lease it already granted instead of taking a second unit of something scarce away from somebody
   * for no reason.
   */
  async placePlanHolds(
    planId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<PlacePlanHoldsOutput, OrchestrationFailure>> {
    const record = this.deps.store.plan(planId);
    if (!record) {
      return fail<OrchestrationFailure>('PLAN_NOT_FOUND', USER_FACING_MESSAGE.PLAN_NOT_FOUND);
    }
    if (!record.result.feasible) {
      return fail<OrchestrationFailure>('PLAN_INFEASIBLE', USER_FACING_MESSAGE.PLAN_INFEASIBLE);
    }

    const order = this.acquisitionOrder(record.search_id, record.plan.parts);
    const acquired: ActiveLease[] = [];

    for (const part of order) {
      if (options.signal?.aborted) {
        return this.unwind(planId, acquired, part.role, 'EXECUTION_ABORTED');
      }

      const entry = providerById(part.provider_id);
      const offer = this.deps.store.offer(record.search_id, part.provider_id, part.resource_id);

      // Invariant K. A directory entry describes a real organisation that never agreed to receive
      // anything from this demo, so it is never leased against. Refused before the call, not after.
      if (!entry || entry.readOnly || offer?.holdable === false) {
        this.deps.log.leaseRefused(part.provider_id, part.resource_id, 'not holdable');
        return this.unwind(planId, acquired, part.role, 'PROVIDER_UNAVAILABLE');
      }

      const result = await this.deps.broker.hold(
        entry,
        {
          resource_id: part.resource_id,
          requested_ttl_seconds: this.ttlSeconds,
          client_request_id: leaseRequestId(planId, part.role),
        },
        { ...(options.signal ? { signal: options.signal } : {}) },
      );

      if (result.state === 'ok') {
        const lease: ActiveLease = {
          role: part.role,
          provider_id: part.provider_id,
          resource_id: part.resource_id,
          hold_id: result.value.hold_id,
          expires_at_epoch_ms: result.value.expires_at_epoch_ms,
          plan_id: planId,
          search_id: record.search_id,
        };
        this.deps.store.putLease(lease);
        acquired.push(lease);
        this.deps.onLeaseAcquired?.(lease);
        this.deps.log.leaseAcquired(
          part.provider_id,
          part.resource_id,
          result.value.hold_id,
          result.value.ttl_seconds,
        );
        continue;
      }

      const reason = failedReason(result);
      this.deps.log.leaseRefused(part.provider_id, part.resource_id, describe(result));
      return this.unwind(planId, acquired, part.role, reason);
    }

    const leases: Lease[] = order
      .map((part) => acquired.find((l) => l.role === part.role))
      .filter((l): l is ActiveLease => l !== undefined)
      .map((l) => ({
        role: l.role,
        provider_id: l.provider_id,
        resource_id: l.resource_id,
        hold_id: l.hold_id,
        expires_at_epoch_ms: l.expires_at_epoch_ms,
      }));

    return ok({ plan_id: planId, leases, status: 'all_held' as const });
  }

  /**
   * Unwind the leases a failed plan took, in reverse acquisition order.
   *
   * Reverse order means the scarcest resource — acquired first — is freed last, and therefore spends
   * the least total time held by a plan that is already dead.
   *
   * An unreachable provider during unwind is recorded as `unreachable` and nothing more is claimed.
   * The provider-authoritative TTL is the backstop, and saying "it will lapse within twenty minutes"
   * is true; saying "released" would not be.
   */
  private async unwind(
    planId: string,
    acquired: readonly ActiveLease[],
    failedRole: PlanPart['role'],
    failedReasonCode: OrchestrationFailure['failed_reason'],
  ): Promise<ToolResult<PlacePlanHoldsOutput, OrchestrationFailure>> {
    this.deps.onCompensating?.(planId);
    this.deps.log.compensationStarted(planId, acquired.length);
    const compensation = await this.releaseAll(acquired);
    const complete = compensation.every((c) => c.status !== 'unreachable');
    this.deps.log.compensationFinished(planId, complete);

    const code: ErrorCode = complete ? 'LEASE_ORCHESTRATION_FAILED' : 'COMPENSATION_INCOMPLETE';
    return fail<OrchestrationFailure>(code, USER_FACING_MESSAGE[code], {
      retryable: failedReasonCode !== 'EXECUTION_ABORTED',
      data: {
        plan_id: planId,
        failed_role: failedRole,
        failed_reason: failedReasonCode,
        compensation,
        compensation_complete: complete,
      },
    });
  }

  /** Release a set of leases in reverse acquisition order, idempotently. */
  private async releaseAll(leases: readonly ActiveLease[]): Promise<CompensationEntry[]> {
    const entries: CompensationEntry[] = [];
    for (const lease of [...leases].reverse()) {
      entries.push(await this.releaseOne(lease));
    }
    return entries;
  }

  /**
   * Release one lease and say exactly what happened to it.
   *
   * `expired` is reported separately from `released` because they are different statements about a
   * scarce resource: one says we let go of it, the other says it had already slipped away. Collapsing
   * them would let a plan take credit for tidying up after itself when it did not.
   */
  async releaseOne(lease: ActiveLease): Promise<CompensationEntry> {
    const entry = providerById(lease.provider_id);
    const base = {
      provider_id: lease.provider_id,
      resource_id: lease.resource_id,
      hold_id: lease.hold_id,
    };

    if (!entry) {
      this.deps.log.leaseReleased(lease.provider_id, lease.hold_id, 'unreachable');
      return { ...base, status: 'unreachable' };
    }

    const result = await this.deps.broker.releaseHold(entry, { hold_id: lease.hold_id });

    if (result.state === 'ok') {
      this.deps.store.dropLease(lease.hold_id);
      this.deps.log.leaseReleased(lease.provider_id, lease.hold_id, result.value.status);
      return { ...base, status: result.value.status };
    }

    if (result.state === 'provider_error' && result.error.error_code === 'HOLD_NOT_FOUND') {
      // The provider has no record of it, so nothing is held. Reporting that as unreachable would
      // leave the UI claiming a lease exists somewhere when it demonstrably does not.
      this.deps.store.dropLease(lease.hold_id);
      this.deps.log.leaseReleased(lease.provider_id, lease.hold_id, 'already_released');
      return { ...base, status: 'already_released' };
    }

    this.deps.log.leaseReleased(lease.provider_id, lease.hold_id, 'unreachable');
    return { ...base, status: 'unreachable' };
  }

  /**
   * Release every lease a plan holds.
   *
   * Accepts a plan with nothing left to release and reports it as complete, because an agent that
   * calls `release_plan` twice, or after the leases have lapsed, has done nothing wrong and should
   * not be told it has.
   */
  async releasePlan(planId: string): Promise<ToolResult<ReleasePlanOutput>> {
    const leases = this.deps.store.leasesForPlan(planId);
    if (leases.length === 0) {
      return ok({ plan_id: planId, released: [], complete: true });
    }
    this.deps.log.compensationStarted(planId, leases.length);
    const released = await this.releaseAll(leases);
    const complete = released.every((r) => r.status !== 'unreachable');
    this.deps.log.compensationFinished(planId, complete);
    return ok({ plan_id: planId, released, complete });
  }
}

function failedReason(result: {
  state: string;
  error?: { error_code: string };
}): OrchestrationFailure['failed_reason'] {
  if (result.state === 'provider_error') {
    return result.error?.error_code === 'HOLD_CONFLICT' ? 'HOLD_CONFLICT' : 'PROVIDER_UNAVAILABLE';
  }
  if (result.state === 'contract_error') return 'PROVIDER_CONTRACT_VIOLATION';
  if (result.state === 'aborted') return 'EXECUTION_ABORTED';
  return 'PROVIDER_UNAVAILABLE';
}

/** One safe phrase for the boundary log. Never a provider-authored string. */
function describe(result: { state: string; error?: { error_code: string } }): string {
  if (result.state === 'provider_error') return result.error?.error_code ?? 'refused';
  if (result.state === 'contract_error') return 'contract violation';
  if (result.state === 'timeout') return 'no answer in time';
  if (result.state === 'aborted') return 'cancelled';
  return 'not reachable';
}
