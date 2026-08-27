/**
 * The nine hub tools. Build plan §9, §42.4, §43.3.
 *
 * This class is the whole product, and it is deliberately free of the browser. It takes a broker, a
 * store, a state machine, a log and a consent controller, and returns `ToolResult` values. It never
 * touches `document.modelContext`, never renders anything, and never reads a clock it was not
 * given. The consequence is that the golden path, the collision, the compensation and the consent
 * race are all testable in Node, at speed, without a browser and without WebMCP — which is the only
 * way any of them get tested at all on a deadline.
 *
 * Three rules hold in every handler here, and each of them is a class of bug rather than a style
 * preference:
 *
 *  1. **Input is validated before anything else.** A WebMCP `inputSchema` is a hint to the agent. It
 *     is not a guarantee about what arrives, and whether the browser enforces it is not this code's
 *     business.
 *
 *  2. **An identifier from a model is a lookup key, never a source of facts.** The agent names
 *     `(provider_id, resource_id)`; every field is then read from the hub's own validated results.
 *     Nothing an agent says about an offer is ever believed, including things it was told a moment
 *     ago by this very hub.
 *
 *  3. **Output is validated on the way out.** Not ceremony: it is the check that catches a hub bug
 *     at the boundary, where the field is named, rather than as an agent behaving strangely three
 *     turns later for reasons nobody can reconstruct.
 */

import {
  HUB_TOOL_NAMES,
  USER_FACING_MESSAGE,
  V,
  fail,
  ok,
  minutesOf,
  type CheckPlanOutput,
  type ComposedPlan,
  type ErrorCode,
  type ExplainGapOutput,
  type FindSupportOutput,
  type GetPlanOutput,
  type HubToolName,
  type MakeReferralOutput,
  type NeedProfile,
  type OrchestrationFailure,
  type PlaceHoldOutput,
  type PlacePlanHoldsOutput,
  type ProviderId,
  type ProviderStatus,
  type ReleaseHoldOutput,
  type ReleasePlanOutput,
  type ToolFailure,
  type ToolResult,
  type Validator,
} from '@threshold/contracts';
import {
  SEARCH_REFERENCE,
  alternativesForRole,
  buildPlanParts,
  checkPlan,
  failedLinks,
  failedRequirements,
  isNearMiss,
  isRelaxable,
  leaseRequestId,
  mintId,
  normalizeAvailability,
  projectNeedForProvider,
  projectedFieldNames,
  rankOffers,
  rolesRequested,
  type NormalizedOffer,
} from '@threshold/domain';

import type { BoundaryLog } from '../audit/boundary-log';
import type { ProviderBroker } from '../broker/broker';
import { displayNameFor, providerById, providersFor } from '../broker/registry';
import type { ConsentController, ReferralDraft } from '../consent/controller';
import type { LeaseOrchestrator } from '../orchestration/orchestrator';
import { HubStateMachine, stateConflictMessage } from '../session/machine';
import type { ActiveLease, SessionStore } from '../session/session';

/** Output budgets from Chrome's guidance. Results are trimmed to fit, and the trim is reported. */
export const MAX_EXACT_MATCHES = 6;
export const MAX_NEAR_MISSES = 4;

export type HubCoreDeps = {
  broker: ProviderBroker;
  store: SessionStore;
  machine: HubStateMachine;
  log: BoundaryLog;
  consent: ConsentController;
  orchestrator: LeaseOrchestrator;
  now?: () => number;
};

export class HubCore {
  private readonly now: () => number;

  constructor(private readonly deps: HubCoreDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Shared guards
  // -------------------------------------------------------------------------

  /** May this tool run from the current state? §13.3. */
  private guardState(tool: HubToolName): ToolFailure<never> | null {
    if (this.deps.machine.allows(tool)) return null;
    return fail('STATE_CONFLICT', stateConflictMessage(tool, this.deps.machine.tag()));
  }

  /**
   * Validate what this handler is about to return.
   *
   * A hub that emits something its own contract forbids has a bug, and the useful moment to find out
   * is here, with the JSON Pointer, rather than in a transcript of an agent doing something odd.
   */
  private guardOutput<T>(validator: Validator<T>, value: T): ToolResult<T> {
    const checked = validator.tryParse(value);
    if (!checked.ok) {
      return fail('INTERNAL_ERROR', `${USER_FACING_MESSAGE.INTERNAL_ERROR} (${checked.error.summary})`);
    }
    return ok(checked.value);
  }

  private expiresInSeconds(epochMs: number): number {
    return Math.max(0, Math.min(1200, Math.round((epochMs - this.now()) / 1000)));
  }

  // -------------------------------------------------------------------------
  // find_support
  // -------------------------------------------------------------------------

  /**
   * Fan out one typed capability profile to every organisation that could answer it.
   *
   * Concurrent, unlike lease acquisition, and for a reason that is the mirror of why acquisition is
   * sequential: a query takes nothing away from anybody. Reading is free; holding is not.
   *
   * A provider that does not answer does not fail the search. It appears in `providers_checked` with
   * its state, so the result is honestly *incomplete* rather than quietly wrong (Invariant H). "Two
   * of three organisations answered" is a true sentence an agent can say to a person; silence is not.
   */
  async findSupport(
    rawInput: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<FindSupportOutput>> {
    const guard = this.guardState('find_support');
    if (guard) return guard;

    const parsed = V.findSupportInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    const need: NeedProfile = parsed.value;
    this.deps.log.agentCalled('find_support', Object.keys(need).length);

    const searchId = mintId('search');
    const entries = providersFor(need.support_kinds);

    const answers = await Promise.all(
      entries.map(async (entry) => {
        const query = projectNeedForProvider(need, { supportKinds: entry.supportKinds });
        // Not calling an organisation at all is stronger minimisation than calling it with an empty
        // question, and it is less traffic against a provider that cannot help.
        if (!query) return null;

        this.deps.log.queriedProvider(entry.id, projectedFieldNames(query));
        const result = await this.deps.broker.queryAvailability(entry, query, options);
        return { entry, result };
      }),
    );

    const offers: NormalizedOffer[] = [];
    const statuses: ProviderStatus[] = [];
    const rejections: Array<{ provider_id: ProviderId; rule: string; path: string }> = [];

    for (const answer of answers) {
      if (!answer) continue;
      const { entry, result } = answer;

      switch (result.state) {
        case 'ok': {
          const { offers: normalized, identityMismatch } = normalizeAvailability(result.value, {
            provider_id: entry.id,
            assertion_class: entry.assertionClass,
          });
          if (identityMismatch) this.deps.log.identityMismatch(entry.id);
          offers.push(...normalized);
          statuses.push({ provider_id: entry.id, state: 'ok' });
          this.deps.log.providerAnswered(entry.id, normalized.length, result.ms);
          break;
        }
        case 'provider_error':
          // An organisation saying "I cannot answer that" in the contract's own vocabulary is not a
          // contract violation. It is unavailable for this question, and it is reported as such.
          statuses.push({ provider_id: entry.id, state: 'unavailable' });
          this.deps.log.providerUnavailable(entry.id, 'unavailable');
          break;
        case 'contract_error':
          statuses.push({
            provider_id: entry.id,
            state: 'contract_error',
            ...(result.path ? { error_path: result.path } : {}),
          });
          rejections.push({ provider_id: entry.id, rule: result.summary, path: result.path });
          this.deps.log.contractViolation(entry.id, result.summary);
          break;
        case 'timeout':
          statuses.push({ provider_id: entry.id, state: 'timeout' });
          this.deps.log.providerUnavailable(entry.id, 'timeout');
          break;
        default:
          statuses.push({ provider_id: entry.id, state: 'unavailable' });
          this.deps.log.providerUnavailable(entry.id, 'unavailable');
          break;
      }
    }

    const exact: NormalizedOffer[] = [];
    const near: Array<{ offer: NormalizedOffer; failures: number; relaxable: boolean }> = [];

    for (const offer of offers) {
      const failures = failedRequirements(need, offer, { reference: SEARCH_REFERENCE });
      if (failures.length === 0) {
        exact.push(offer);
      } else if (isNearMiss(failures)) {
        near.push({ offer, failures: failures.length, relaxable: isRelaxable(failures) });
      }
    }

    const rankedExact = rankOffers(need, exact);
    const rankedNear = rankOffers(need, near.map((n) => n.offer));

    /**
     * Which requested roles no *exact* match was found for.
     *
     * Exact rather than any-offer, because this field's job is to tell the agent whether a plan is
     * possible yet, and a near miss cannot be composed into one. An agent told "there are transport
     * offers" when none of them is usable would compose a plan that cannot pass `check_plan`.
     */
    const rolesWithExact = new Set(rankedExact.map((o) => o.role));
    const rolesWithNoOffer = rolesRequested(need).filter((r) => !rolesWithExact.has(r));

    const session = {
      search_id: searchId,
      need,
      offers,
      exact: rankedExact,
      nearMisses: rankedNear,
      providerStatuses: statuses,
      rejections,
      createdAtEpochMs: this.now(),
    };
    this.deps.store.putSearch(session);
    this.deps.machine.transition({ tag: 'SEARCHED', search_id: searchId, hold_ids: [] });

    const output: FindSupportOutput = {
      search_id: searchId,
      exact_matches: rankedExact.slice(0, MAX_EXACT_MATCHES).map((o) => ({
        provider_id: o.provider_id,
        resource_id: o.resource_id,
        role: o.role,
        support_kind: o.support_kind,
        window: o.window,
        ...(o.admission ? { admission: o.admission } : {}),
        ...(o.arrival ? { arrival: o.arrival } : {}),
        holdable: o.holdable,
        units_left: o.units,
        assertion_class: o.assertion_class,
      })),
      near_misses: rankedNear.slice(0, MAX_NEAR_MISSES).map((o) => {
        const entry = near.find((n) => n.offer === o)!;
        return {
          provider_id: o.provider_id,
          resource_id: o.resource_id,
          role: o.role,
          failed_count: entry.failures,
          relaxable: entry.relaxable,
        };
      }),
      providers_checked: statuses,
      ...(rolesWithNoOffer.length > 0 ? { roles_with_no_offer: rolesWithNoOffer } : {}),
      ...(rankedExact.length > MAX_EXACT_MATCHES || rankedNear.length > MAX_NEAR_MISSES
        ? {
            truncated: {
              exact_matches_total: rankedExact.length,
              near_misses_total: rankedNear.length,
            },
          }
        : {}),
    };

    if (statuses.length > 0 && statuses.every((s) => s.state !== 'ok')) {
      // Every organisation failed. Reporting an empty result as a successful search would tell a
      // person nothing is available when in fact nothing was asked.
      return fail('FEDERATION_UNAVAILABLE', USER_FACING_MESSAGE.FEDERATION_UNAVAILABLE);
    }

    return this.guardOutput(V.findSupportOutput, output);
  }

  // -------------------------------------------------------------------------
  // explain_gap
  // -------------------------------------------------------------------------

  /**
   * Say exactly what failed, at one of two altitudes.
   *
   * Offer scope: which of the person's stated requirements this offer does not meet.
   * Plan scope: which links *between organisations* fail, and which organisation to go back to.
   *
   * Neither answer is generated. Both are computed by the deterministic engines in `@threshold/domain`
   * and formatted here, which is the division of labour the whole design rests on: the code says what
   * failed, the model has the conversation with the person about it.
   */
  async explainGap(rawInput: unknown): Promise<ToolResult<ExplainGapOutput>> {
    const guard = this.guardState('explain_gap');
    if (guard) return guard;

    const parsed = V.explainGapInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    const input = parsed.value as { search_id: string; match_id?: string; plan_id?: string };
    this.deps.log.agentCalled('explain_gap', Object.keys(input).length);

    const session = this.deps.store.search(input.search_id);
    if (!session) return fail('MATCH_NOT_FOUND', USER_FACING_MESSAGE.MATCH_NOT_FOUND);

    if (input.plan_id !== undefined) {
      const record = this.deps.store.plan(input.plan_id);
      if (!record || record.search_id !== session.search_id) {
        return fail('PLAN_NOT_FOUND', USER_FACING_MESSAGE.PLAN_NOT_FOUND);
      }

      const links = failedLinks(record.result);
      // Alternatives are offered for the part the failing link says to renegotiate with, so the
      // agent can re-check without a second fan-out against organisations that did nothing wrong.
      const first = links[0];
      const culprit = first
        ? record.plan.parts.find((p) => p.provider_id === first.renegotiate_with)
        : undefined;

      const output: ExplainGapOutput = {
        scope: 'plan',
        plan_id: record.plan_id,
        failed_links: links.map((l) => ({
          kind: l.kind,
          ...(l.from ? { from: l.from } : {}),
          ...(l.to ? { to: l.to } : {}),
          field: l.field,
          required: l.required,
          offered: l.offered,
          renegotiate_with: l.renegotiate_with,
        })),
        ...(culprit
          ? {
              alternatives_same_role: alternativesForRole(culprit.role, session.offers, {
                provider_id: culprit.provider_id,
                resource_id: culprit.resource_id,
              }).slice(0, 6),
            }
          : {}),
        relaxable: links.length > 0 && links.every((l) => l.relaxable === true),
      };
      return this.guardOutput(V.explainGapOutput, output);
    }

    const offer = this.deps.store.offerByResource(session.search_id, input.match_id!);
    if (!offer) return fail('MATCH_NOT_FOUND', USER_FACING_MESSAGE.MATCH_NOT_FOUND);

    const failures = failedRequirements(session.need, offer, { reference: SEARCH_REFERENCE });
    const output: ExplainGapOutput = {
      scope: 'match',
      match_id: offer.resource_id,
      failed_requirements: failures.slice(0, 12),
      alternatives_same_role: alternativesForRole(offer.role, session.offers, {
        provider_id: offer.provider_id,
        resource_id: offer.resource_id,
      }).slice(0, 6),
      relaxable: isRelaxable(failures),
    };
    return this.guardOutput(V.explainGapOutput, output);
  }

  // -------------------------------------------------------------------------
  // check_plan
  // -------------------------------------------------------------------------

  /**
   * The load-bearing tool. §42.
   *
   * Everything else in this file federates. This asks whether several offers, held at organisations
   * that cannot see each other, satisfy *each other* — and it is the one question that has no
   * non-federated implementation, because the facts it compares live at three companies.
   *
   * Note what happens on an infeasible result: the state does *not* advance, so `place_plan_holds`
   * is not registered. An agent cannot take leases against a plan that cannot happen, because the
   * tool to do so does not exist yet.
   */
  async checkPlan(rawInput: unknown): Promise<ToolResult<CheckPlanOutput>> {
    const guard = this.guardState('check_plan');
    if (guard) return guard;

    const parsed = V.checkPlanInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    const input = parsed.value;
    this.deps.log.agentCalled('check_plan', input.parts.length);

    const session = this.deps.store.search(input.search_id);
    if (!session) return fail('MATCH_NOT_FOUND', USER_FACING_MESSAGE.MATCH_NOT_FOUND);

    const built = buildPlanParts(input.parts, session.offers);
    if ('error' in built) {
      const message =
        built.error.reason === 'duplicate_role'
          ? `A plan can have only one ${built.error.role}.`
          : built.error.reason === 'role_mismatch'
            ? `${built.error.request.resource_id} is a ${built.error.actualRole}, not a ${built.error.request.role}.`
            : USER_FACING_MESSAGE.MATCH_NOT_FOUND;
      return fail('MATCH_NOT_FOUND', message);
    }

    const planId = mintId('plan');
    const plan: ComposedPlan = {
      plan_id: planId,
      search_id: session.search_id,
      need: session.need,
      parts: built.parts,
    };

    // The plan is validated before it is checked. A plan is the object every later step reads from,
    // and a malformed one would make every link verdict meaningless rather than wrong.
    const validPlan = V.composedPlan.tryParse(plan);
    if (!validPlan.ok) {
      return fail('INTERNAL_ERROR', `${USER_FACING_MESSAGE.INTERNAL_ERROR} (${validPlan.error.summary})`);
    }

    const result = checkPlan(validPlan.value);
    this.deps.store.putPlan({
      plan_id: planId,
      search_id: session.search_id,
      plan: validPlan.value,
      result,
    });
    this.deps.log.planChecked(planId, result.feasible, failedLinks(result).length);

    // The plan id is carried whether or not the plan works, because the failing case is the one a
    // person most needs to see: the page has to be able to render *which* link failed and which
    // organisation to go back to. What the feasible case additionally buys is the tag, and the tag
    // is what decides the tool surface — so an infeasible plan is fully visible and still cannot be
    // leased against, which is exactly the intended pair of properties.
    this.deps.machine.transition({
      tag: result.feasible ? 'PLAN_COMPOSED' : 'SEARCHED',
      search_id: session.search_id,
      plan_id: planId,
      hold_ids: [],
    });

    const output: CheckPlanOutput = {
      plan_id: planId,
      feasible: result.feasible,
      links: result.links.slice(0, 12),
      ...(result.missingRoles.length > 0 ? { missing_roles: result.missingRoles } : {}),
    };
    return this.guardOutput(V.checkPlanOutput, output);
  }

  // -------------------------------------------------------------------------
  // place_hold
  // -------------------------------------------------------------------------

  /** Lease one resource, for the case where a person only needs one thing. */
  async placeHold(
    rawInput: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<PlaceHoldOutput>> {
    const guard = this.guardState('place_hold');
    if (guard) return guard;

    const parsed = V.placeHoldInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    this.deps.log.agentCalled('place_hold', 2);

    const session = this.deps.store.search(parsed.value.search_id);
    if (!session) return fail('MATCH_NOT_FOUND', USER_FACING_MESSAGE.MATCH_NOT_FOUND);

    const offer = this.deps.store.offerByResource(session.search_id, parsed.value.match_id);
    if (!offer) return fail('MATCH_NOT_FOUND', USER_FACING_MESSAGE.MATCH_NOT_FOUND);

    const entry = providerById(offer.provider_id);
    // Invariant K, enforced twice: the offer says so and the registry says so. A real organisation
    // that never agreed to receive anything from this demo is never leased against.
    if (!offer.holdable || !entry || entry.readOnly) {
      return fail('NOT_HOLDABLE', USER_FACING_MESSAGE.NOT_HOLDABLE);
    }

    const result = await this.deps.broker.hold(
      entry,
      {
        resource_id: offer.resource_id,
        requested_ttl_seconds: 1200,
        // Derived, not minted: a retry after an ambiguous network result must return the same lease
        // rather than take a second unit of something scarce.
        client_request_id: leaseRequestId(session.search_id, `single:${offer.resource_id}`),
      },
      options,
    );

    if (result.state !== 'ok') {
      const code = holdFailureCode(result);
      this.deps.log.leaseRefused(offer.provider_id, offer.resource_id, code);
      return fail(code, USER_FACING_MESSAGE[code]);
    }

    const lease: ActiveLease = {
      role: offer.role,
      provider_id: offer.provider_id,
      resource_id: offer.resource_id,
      hold_id: result.value.hold_id,
      expires_at_epoch_ms: result.value.expires_at_epoch_ms,
      search_id: session.search_id,
    };
    this.deps.store.putLease(lease);
    this.deps.log.leaseAcquired(
      offer.provider_id,
      offer.resource_id,
      result.value.hold_id,
      result.value.ttl_seconds,
    );
    this.deps.machine.transition({
      tag: 'HELD',
      search_id: session.search_id,
      hold_ids: [lease.hold_id],
    });

    return this.guardOutput(V.placeHoldOutput, {
      hold_id: lease.hold_id,
      resource_id: lease.resource_id,
      provider_id: lease.provider_id,
      expires_in_seconds: this.expiresInSeconds(lease.expires_at_epoch_ms),
    });
  }

  // -------------------------------------------------------------------------
  // place_plan_holds
  // -------------------------------------------------------------------------

  /** Lease every leg of a feasible plan, or none of them. §43. */
  async placePlanHolds(
    rawInput: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<PlacePlanHoldsOutput, OrchestrationFailure>> {
    const guard = this.guardState('place_plan_holds');
    if (guard) return guard;

    const parsed = V.placePlanHoldsInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail<OrchestrationFailure>(
        'INVALID_INPUT',
        `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`,
      );
    }
    this.deps.log.agentCalled('place_plan_holds', 1);

    const record = this.deps.store.plan(parsed.value.plan_id);
    if (!record) {
      return fail<OrchestrationFailure>('PLAN_NOT_FOUND', USER_FACING_MESSAGE.PLAN_NOT_FOUND);
    }

    const result = await this.deps.orchestrator.placePlanHolds(parsed.value.plan_id, options);

    if (!result.ok) {
      // Compensation has already run to completion inside the orchestrator, so there is nothing
      // held and the page goes back to where a person can choose differently. COMPENSATING is not a
      // state this product can get stuck in (§43.5).
      this.deps.machine.transition({
        tag: 'SEARCHED',
        search_id: record.search_id,
        hold_ids: [],
      });
      return result;
    }

    this.deps.machine.transition({
      tag: 'HELD',
      search_id: record.search_id,
      plan_id: record.plan_id,
      hold_ids: result.data.leases.map((l) => l.hold_id),
    });

    const checked = V.placePlanHoldsOutput.tryParse(result.data);
    if (!checked.ok) {
      return fail<OrchestrationFailure>(
        'INTERNAL_ERROR',
        `${USER_FACING_MESSAGE.INTERNAL_ERROR} (${checked.error.summary})`,
      );
    }
    return ok(checked.value);
  }

  // -------------------------------------------------------------------------
  // release_hold / release_plan
  // -------------------------------------------------------------------------

  async releaseHold(rawInput: unknown): Promise<ToolResult<ReleaseHoldOutput>> {
    const guard = this.guardState('release_hold');
    if (guard) return guard;

    const parsed = V.releaseHoldInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    this.deps.log.agentCalled('release_hold', 1);

    const lease = this.deps.store.lease(parsed.value.hold_id);
    if (!lease) return fail('HOLD_NOT_FOUND', USER_FACING_MESSAGE.HOLD_NOT_FOUND);

    const entry = await this.deps.orchestrator.releaseOne(lease);
    if (entry.status === 'unreachable') {
      return fail('COMPENSATION_INCOMPLETE', USER_FACING_MESSAGE.COMPENSATION_INCOMPLETE);
    }

    this.settleAfterRelease(lease);
    return this.guardOutput(V.releaseHoldOutput, {
      hold_id: entry.hold_id,
      status: entry.status,
    });
  }

  async releasePlan(rawInput: unknown): Promise<ToolResult<ReleasePlanOutput>> {
    const guard = this.guardState('release_plan');
    if (guard) return guard;

    const parsed = V.releasePlanInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    this.deps.log.agentCalled('release_plan', 1);

    const record = this.deps.store.plan(parsed.value.plan_id);
    if (!record) return fail('PLAN_NOT_FOUND', USER_FACING_MESSAGE.PLAN_NOT_FOUND);

    const result = await this.deps.orchestrator.releasePlan(parsed.value.plan_id);
    if (!result.ok) return result;

    this.deps.machine.transition({
      tag: 'SEARCHED',
      search_id: record.search_id,
      hold_ids: this.deps.store.allLeases().map((l) => l.hold_id),
    });
    return this.guardOutput(V.releasePlanOutput, result.data);
  }

  /** After one lease goes, where does the page stand? */
  private settleAfterRelease(released: ActiveLease): void {
    const remaining = this.deps.store.allLeases();
    if (remaining.length === 0) {
      this.deps.machine.transition({
        tag: 'SEARCHED',
        search_id: released.search_id,
        hold_ids: [],
      });
      return;
    }
    this.deps.machine.patch({ hold_ids: remaining.map((l) => l.hold_id) });
  }

  // -------------------------------------------------------------------------
  // make_referral
  // -------------------------------------------------------------------------

  /**
   * The one tool whose execute() does not resolve on its own.
   *
   * It opens a panel and returns a Promise that settles on a human action. The agent's call is
   * genuinely pending in the meantime, which is the entire mechanism: consent lives in the page,
   * with the page's framing and the page's editable payload, rather than in a host dialog that can
   * only approve or refuse an opaque call.
   *
   * A second call while a panel is open returns STATE_CONFLICT rather than unregistering the tool
   * mid-execution. §13.3: concurrency is the state machine's job, not the platform's.
   */
  async makeReferral(
    rawInput: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<MakeReferralOutput>> {
    const guard = this.guardState('make_referral');
    if (guard) return guard;

    if (this.deps.consent.isPending()) {
      return fail(
        'STATE_CONFLICT',
        'A referral is already waiting for the person to review it. Wait for that one to settle.',
      );
    }

    const parsed = V.makeReferralInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    const input = parsed.value;
    this.deps.log.agentCalled('make_referral', Object.keys(input).length);

    const lease = this.deps.store.lease(input.hold_id);
    if (!lease) return fail('HOLD_NOT_FOUND', USER_FACING_MESSAGE.HOLD_NOT_FOUND);
    if (lease.expires_at_epoch_ms <= this.now()) {
      return fail('HOLD_EXPIRED', USER_FACING_MESSAGE.HOLD_EXPIRED);
    }

    const entry = providerById(lease.provider_id);
    if (!entry || entry.readOnly) return fail('NOT_HOLDABLE', USER_FACING_MESSAGE.NOT_HOLDABLE);

    const offer = this.deps.store.offer(lease.search_id, lease.provider_id, lease.resource_id);
    const planRecord = lease.plan_id ? this.deps.store.plan(lease.plan_id) : undefined;

    const proposed: ReferralDraft = {
      person_name: input.person_name,
      contact_method: input.contact_method,
      contact_value: input.contact_value,
      preferred_contact_window: input.preferred_contact_window,
    };

    const previousTag = this.deps.machine.tag();
    this.deps.machine.transition({
      tag: 'CONSENT_PENDING',
      search_id: lease.search_id,
      ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
      hold_ids: this.deps.store.allLeases().map((l) => l.hold_id),
      consent_hold_id: lease.hold_id,
    });
    this.deps.log.consentPending(lease.provider_id, [
      'person_name',
      'contact_method',
      'contact_value',
      'preferred_contact_window',
    ]);

    const outcome = await this.deps.consent.open({
      hold_id: lease.hold_id,
      provider_id: lease.provider_id,
      providerName: entry.displayName,
      providerOrigin: entry.origin,
      resource_id: lease.resource_id,
      role: lease.role,
      window: offer?.window ?? { from: { day: 0, at: '00:00' }, to: { day: 0, at: '00:00' } },
      retention: entry.retention,
      expiresAtEpochMs: lease.expires_at_epoch_ms,
      proposed,
      planContext: (planRecord?.plan.parts ?? [])
        .filter((p) => p.resource_id !== lease.resource_id)
        .map((p) => ({
          role: p.role,
          providerName: displayNameFor(p.provider_id),
          resource_id: p.resource_id,
        })),
      ...(options.signal ? { signal: options.signal } : {}),
      submit: async (draft) => {
        const result = await this.deps.broker.acceptReferral(entry, {
          hold_id: lease.hold_id,
          client_request_id: leaseRequestId(lease.hold_id, 'referral'),
          person_name: draft.person_name,
          contact_method: draft.contact_method,
          contact_value: draft.contact_value,
          preferred_contact_window: draft.preferred_contact_window,
        });

        // The one line in the system recording that identifying data crossed an origin. It takes
        // field names and has nowhere to put a value.
        this.deps.log.referralSent(lease.provider_id, [
          'person_name',
          'contact_method',
          'contact_value',
          'preferred_contact_window',
        ]);

        if (result.state === 'ok') {
          this.deps.log.referralAccepted(lease.provider_id, result.value.referral_id);
          return {
            ok: true as const,
            referral_id: result.value.referral_id,
            ...(result.value.next_step !== undefined ? { next_step: result.value.next_step } : {}),
          };
        }

        const code = referralFailureCode(result);
        return {
          ok: false as const,
          failure: {
            code,
            message: USER_FACING_MESSAGE[code],
            // Only a dead lease is fatal. A provider that did not answer can be tried again, and
            // closing the panel would throw away the values the person just checked.
            fatal: code === 'HOLD_EXPIRED' || code === 'HOLD_NOT_FOUND',
          },
        };
      },
    });

    switch (outcome.kind) {
      case 'sent': {
        this.deps.log.consentSettled('sent');
        this.deps.store.dropLease(lease.hold_id);
        const parts = (planRecord?.plan.parts ?? [offerAsPart(lease, offer)]).map((p) => ({
          role: p.role,
          provider_id: p.provider_id,
          resource_id: p.resource_id,
          window: p.window,
        }));
        this.deps.store.putReferral({
          referral_id: outcome.referral_id,
          provider_id: lease.provider_id,
          hold_id: lease.hold_id,
          resource_id: lease.resource_id,
          fields_sent: outcome.fields_sent,
          human_edited: outcome.human_edited,
          ...(outcome.next_step !== undefined ? { next_step: outcome.next_step } : {}),
          ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
          parts,
        });
        this.deps.machine.transition({
          tag: 'REFERRED',
          search_id: lease.search_id,
          ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
          hold_ids: this.deps.store.allLeases().map((l) => l.hold_id),
          referral_id: outcome.referral_id,
        });
        return this.guardOutput(V.makeReferralOutput, {
          referral_id: outcome.referral_id,
          provider_id: lease.provider_id,
          fields_sent: [...outcome.fields_sent],
          human_edited: [...outcome.human_edited],
          ...(outcome.next_step !== undefined ? { next_step: outcome.next_step } : {}),
        });
      }

      case 'expired': {
        this.deps.log.consentSettled('expired');
        this.deps.store.dropLease(lease.hold_id);
        this.settleAfterRelease(lease);
        return fail('HOLD_EXPIRED', USER_FACING_MESSAGE.HOLD_EXPIRED);
      }

      case 'cancelled':
      case 'aborted': {
        this.deps.log.consentSettled(outcome.kind === 'cancelled' ? 'cancelled' : 'aborted');
        // The lease survives a cancellation: the person said no to sending their details, not to
        // the bed. Going back to where they were is the whole difference between a gate and a wall.
        this.deps.machine.transition({
          tag: previousTag === 'CONSENT_PENDING' ? 'HELD' : previousTag,
          search_id: lease.search_id,
          ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
          hold_ids: this.deps.store.allLeases().map((l) => l.hold_id),
        });
        const code: ErrorCode = outcome.kind === 'cancelled' ? 'CONSENT_CANCELLED' : 'EXECUTION_ABORTED';
        return fail(code, USER_FACING_MESSAGE[code]);
      }

      case 'failed': {
        this.deps.log.consentSettled('cancelled');
        if (outcome.code === 'HOLD_EXPIRED' || outcome.code === 'HOLD_NOT_FOUND') {
          this.deps.store.dropLease(lease.hold_id);
          this.settleAfterRelease(lease);
        } else {
          this.deps.machine.transition({
            tag: 'HELD',
            search_id: lease.search_id,
            ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
            hold_ids: this.deps.store.allLeases().map((l) => l.hold_id),
          });
        }
        return fail(outcome.code, outcome.message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // get_plan
  // -------------------------------------------------------------------------

  async getPlan(rawInput: unknown): Promise<ToolResult<GetPlanOutput>> {
    const guard = this.guardState('get_plan');
    if (guard) return guard;

    const parsed = V.getPlanInput.tryParse(rawInput);
    if (!parsed.ok) {
      return fail('INVALID_INPUT', `${USER_FACING_MESSAGE.INVALID_INPUT} (${parsed.error.summary})`);
    }
    this.deps.log.agentCalled('get_plan', 1);

    const receipt = this.deps.store.referral(parsed.value.referral_id);
    if (!receipt) return fail('PLAN_NOT_FOUND', USER_FACING_MESSAGE.PLAN_NOT_FOUND);

    return this.guardOutput(V.getPlanOutput, {
      referral_id: receipt.referral_id,
      status: 'referred' as const,
      parts: receipt.parts.map((p) => ({
        role: p.role,
        provider_id: p.provider_id,
        resource_id: p.resource_id,
        window: p.window,
      })),
      ...(receipt.next_step !== undefined ? { next_step: receipt.next_step } : {}),
    });
  }

  /** Dispatch by name. Used by the WebMCP definitions and by the eval harness. */
  handler(name: HubToolName): (input: unknown, ctx: { signal?: AbortSignal }) => Promise<ToolResult<unknown, unknown>> {
    const table: Record<HubToolName, (i: unknown, c: { signal?: AbortSignal }) => Promise<ToolResult<unknown, unknown>>> = {
      find_support: (i, c) => this.findSupport(i, c),
      explain_gap: (i) => this.explainGap(i),
      check_plan: (i) => this.checkPlan(i),
      place_hold: (i, c) => this.placeHold(i, c),
      place_plan_holds: (i, c) => this.placePlanHolds(i, c),
      release_hold: (i) => this.releaseHold(i),
      release_plan: (i) => this.releasePlan(i),
      make_referral: (i, c) => this.makeReferral(i, c),
      get_plan: (i) => this.getPlan(i),
    };
    return table[name];
  }
}

/** Every tool name, re-exported so the lifecycle manager and the evals agree on the list. */
export const ALL_HUB_TOOLS = HUB_TOOL_NAMES;

/** A provider refusing a lease, translated into the hub's own error vocabulary. */
function holdFailureCode(result: {
  state: string;
  error?: { error_code: string };
}): Extract<ErrorCode, 'HOLD_CONFLICT' | 'NOT_HOLDABLE' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_CONTRACT_VIOLATION'> {
  if (result.state === 'provider_error') {
    if (result.error?.error_code === 'HOLD_CONFLICT') return 'HOLD_CONFLICT';
    if (result.error?.error_code === 'NOT_HOLDABLE') return 'NOT_HOLDABLE';
    return 'PROVIDER_UNAVAILABLE';
  }
  if (result.state === 'contract_error') return 'PROVIDER_CONTRACT_VIOLATION';
  return 'PROVIDER_UNAVAILABLE';
}

function referralFailureCode(result: { state: string; error?: { error_code: string } }): ErrorCode {
  if (result.state === 'provider_error') {
    const code = result.error?.error_code;
    if (code === 'HOLD_EXPIRED') return 'HOLD_EXPIRED';
    if (code === 'HOLD_NOT_FOUND') return 'HOLD_NOT_FOUND';
    return 'REFERRAL_REJECTED';
  }
  if (result.state === 'contract_error') return 'PROVIDER_CONTRACT_VIOLATION';
  if (result.state === 'aborted') return 'EXECUTION_ABORTED';
  return 'PROVIDER_UNAVAILABLE';
}

/** A single-resource referral still reports a one-part plan, so `get_plan` has one shape. */
function offerAsPart(
  lease: ActiveLease,
  offer: NormalizedOffer | undefined,
): { role: ActiveLease['role']; provider_id: ProviderId; resource_id: string; window: NormalizedOffer['window'] } {
  return {
    role: lease.role,
    provider_id: lease.provider_id,
    resource_id: lease.resource_id,
    window: offer?.window ?? { from: { day: 0, at: '00:00' }, to: { day: 0, at: '00:00' } },
  };
}

/** Exported for the diagnostics panel: how long a lease has left, in whole seconds. */
export function secondsLeft(expiresAtEpochMs: number, nowMs: number): number {
  return Math.max(0, Math.round((expiresAtEpochMs - nowMs) / 1000));
}

/** Exported for tests: the search reference the matcher measures from. */
export const SEARCH_REFERENCE_MINUTES = minutesOf(SEARCH_REFERENCE);
