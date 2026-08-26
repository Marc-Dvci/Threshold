/**
 * The joint feasibility engine. Build plan §42.3.
 *
 * This is the centre of the product. Everything else federates a search; this asks whether several
 * offers, held at organisations that cannot see each other, satisfy *each other*.
 *
 * Four properties, all deliberate:
 *
 *  1. **Deterministic.** Pure function, no model, no clock, no I/O. Given a plan it returns the same
 *     verdict every time, which is what lets a person argue with it. A model that opined on
 *     feasibility would be unarguable, and being told "the AI thinks this will not work" is not help.
 *
 *  2. **Fixed evaluation order.** `LINK_ORDER`, structural checks first. A plan that fails three
 *     links reports them in the same order every run, so the first reported reason is stable and the
 *     film says the same sentence in every take.
 *
 *  3. **Every failure, not the first.** The agent needs to know whether it is one conversation or
 *     three before it starts making phone calls on someone's behalf.
 *
 *  4. **Every failure names who to talk to.** `renegotiate_with` is the field that makes this useful
 *     rather than merely correct. A failing link has two ends and usually only one is worth a
 *     conversation: telling a respite unit that a van is slow achieves nothing.
 */

import type {
  ComposedPlan,
  FailedLink,
  Instant,
  LinkKind,
  LinkResult,
  PlanPart,
  PlanPartRole,
  ProviderId,
} from '@threshold/contracts';
import { LINK_ORDER, isAfter, isBeforeOrEqual, minutesOf } from '@threshold/contracts';
import { KIND_ROLE } from '@threshold/contracts';
import type { NormalizedOffer } from './normalize.js';

export type CheckPlanResult = {
  feasible: boolean;
  links: LinkResult[];
  /** Roles the need asked for that the plan does not fill. */
  missingRoles: PlanPartRole[];
};

/** Which links can be fixed by swapping or relaxing a part, and which are structural. */
const RELAXABLE_LINKS: Readonly<Record<LinkKind, boolean>> = {
  // A bed in another town is not something you talk a person into.
  single_area: false,
  capability_at_both_ends: true,
  arrival_before_admission: true,
  cover_continuity: true,
  placement_before_deadline: true,
};

function partBy(plan: ComposedPlan, role: PlanPartRole): PlanPart | undefined {
  return plan.parts.find((p) => p.role === role);
}

function fail(
  kind: LinkKind,
  detail: {
    from?: string;
    to?: string;
    field: string;
    required: string;
    offered: string;
    renegotiate_with: ProviderId;
  },
): FailedLink {
  return {
    kind,
    ok: false,
    ...(detail.from !== undefined ? { from: detail.from } : {}),
    ...(detail.to !== undefined ? { to: detail.to } : {}),
    field: detail.field,
    required: detail.required,
    offered: detail.offered,
    renegotiate_with: detail.renegotiate_with,
    relaxable: RELAXABLE_LINKS[kind],
  };
}

function pass(kind: LinkKind, from?: string, to?: string): LinkResult {
  return {
    kind,
    ok: true,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

const clock = (i: Instant): string => i.at;

// ---------------------------------------------------------------------------
// The individual link checks
// ---------------------------------------------------------------------------

/** Every part serves the area the person needs. */
function checkSingleArea(plan: ComposedPlan): LinkResult[] {
  const offending = plan.parts.filter((p) => p.service_area !== plan.need.service_area);
  if (offending.length === 0) return [pass('single_area')];
  return offending.map((p) =>
    fail('single_area', {
      from: p.resource_id,
      field: 'service_area',
      required: plan.need.service_area,
      offered: p.service_area,
      renegotiate_with: p.provider_id,
    }),
  );
}

/**
 * A hoist at the bed and none in the van is not a plan.
 *
 * The check nothing else can make. A per-offer search asks "does this van have a hoist" and gets a
 * true answer about the wrong question; the question is whether the equipment exists at *both ends*
 * of the journey the plan actually describes.
 *
 * Cover is excluded on purpose: cover happens in the person's own home, where their own equipment
 * is, so requiring the care agency to bring a hoist would reject perfectly usable offers.
 */
function checkCapabilityAtBothEnds(plan: ComposedPlan): LinkResult[] {
  if (!plan.need.hoist_required) return [];

  const placement = partBy(plan, 'placement');
  const transport = partBy(plan, 'transport');
  if (!placement || !transport) return [];

  const results: LinkResult[] = [];
  for (const part of [transport, placement]) {
    if (!part.capabilities.hoist_available) {
      results.push(
        fail('capability_at_both_ends', {
          from: transport.resource_id,
          to: placement.resource_id,
          field: 'hoist_available',
          required: 'true at both ends',
          offered: `false at ${part.resource_id}`,
          renegotiate_with: part.provider_id,
        }),
      );
    }
  }
  return results.length > 0
    ? results
    : [pass('capability_at_both_ends', transport.resource_id, placement.resource_id)];
}

/**
 * The van has to arrive before the bed stops admitting.
 *
 * The failing link the film names out loud: the bed admits until 06:40, the earliest that van
 * arrives is 07:10. `renegotiate_with` is the transport provider, because the admission cut-off is a
 * ward handover and the journey time is a route.
 */
function checkArrivalBeforeAdmission(plan: ComposedPlan): LinkResult[] {
  const placement = partBy(plan, 'placement');
  const transport = partBy(plan, 'transport');
  if (!placement || !transport) return [];
  if (!placement.admission || !transport.arrival) return [];

  if (isAfter(transport.arrival, placement.admission.to)) {
    return [
      fail('arrival_before_admission', {
        from: transport.resource_id,
        to: placement.resource_id,
        field: 'arrival_before_admission',
        required: clock(placement.admission.to),
        offered: clock(transport.arrival),
        renegotiate_with: transport.provider_id,
      }),
    ];
  }
  return [pass('arrival_before_admission', transport.resource_id, placement.resource_id)];
}

/**
 * Cover has to last until the person is collected.
 *
 * The gap this finds is an hour of a person with dementia alone in a house, which is the kind of
 * thing that is obvious once stated and invisible in two separate booking confirmations.
 *
 * With no transport leg, the person is collected at the admission window's start instead.
 */
function checkCoverContinuity(plan: ComposedPlan): LinkResult[] {
  const cover = partBy(plan, 'cover');
  if (!cover) return [];

  const transport = partBy(plan, 'transport');
  const placement = partBy(plan, 'placement');
  const collection: Instant | undefined = transport?.pickup_earliest ?? placement?.admission?.from;
  if (!collection) return [];

  if (minutesOf(cover.window.to) < minutesOf(collection)) {
    return [
      fail('cover_continuity', {
        from: cover.resource_id,
        to: transport?.resource_id ?? placement!.resource_id,
        field: 'cover_ends_before_collection',
        required: `>=${clock(collection)}`,
        offered: clock(cover.window.to),
        renegotiate_with: cover.provider_id,
      }),
    ];
  }
  return [pass('cover_continuity', cover.resource_id, transport?.resource_id)];
}

/** The placement has to be in effect before the person has to be somewhere else. */
function checkPlacementBeforeDeadline(plan: ComposedPlan): LinkResult[] {
  const placement = partBy(plan, 'placement');
  if (!placement) return [];

  if (!isBeforeOrEqual(placement.window.from, plan.need.deadline)) {
    return [
      fail('placement_before_deadline', {
        from: placement.resource_id,
        field: 'placement_starts',
        required: `<=${clock(plan.need.deadline)}`,
        offered: clock(placement.window.from),
        renegotiate_with: placement.provider_id,
      }),
    ];
  }
  return [pass('placement_before_deadline', placement.resource_id)];
}

const CHECKS: Readonly<Record<LinkKind, (plan: ComposedPlan) => LinkResult[]>> = {
  single_area: checkSingleArea,
  capability_at_both_ends: checkCapabilityAtBothEnds,
  arrival_before_admission: checkArrivalBeforeAdmission,
  cover_continuity: checkCoverContinuity,
  placement_before_deadline: checkPlacementBeforeDeadline,
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Check a plan.
 *
 * A link that does not apply to this plan's shape contributes nothing, rather than a vacuous pass.
 * "Transport arrives in time: yes" on a plan with no transport leg would be a green tick that means
 * nothing, and a green tick that means nothing is worse than silence.
 */
export function checkPlan(plan: ComposedPlan): CheckPlanResult {
  const links: LinkResult[] = [];
  for (const kind of LINK_ORDER) {
    links.push(...CHECKS[kind](plan));
  }

  const requestedRoles = new Set(plan.need.support_kinds.map((k) => KIND_ROLE[k]));
  const presentRoles = new Set(plan.parts.map((p) => p.role));
  const missingRoles = [...requestedRoles].filter((r) => !presentRoles.has(r));

  const failing = links.some((l) => !l.ok);
  return {
    feasible: !failing && missingRoles.length === 0,
    links,
    missingRoles,
  };
}

export function failedLinks(result: CheckPlanResult): FailedLink[] {
  return result.links.filter((l): l is FailedLink => !l.ok);
}

// ---------------------------------------------------------------------------
// Building a plan from validated offers
// ---------------------------------------------------------------------------

/** A part the agent named: a role plus a `(provider, resource)` address into the search results. */
export type PartRequest = {
  role: PlanPartRole;
  provider_id: ProviderId;
  resource_id: string;
};

export type BuildPlanError =
  | { reason: 'unknown_part'; request: PartRequest }
  | { reason: 'role_mismatch'; request: PartRequest; actualRole: PlanPartRole }
  | { reason: 'duplicate_role'; role: PlanPartRole };

/**
 * Build a plan from requests, resolving each against validated offers.
 *
 * A resource identifier from a model is a **lookup key, never a source of facts**. Every field of
 * every part comes from the hub's own validated store; nothing the agent sent is copied into the
 * plan except the address it used to point at something. Same rule as `place_hold`, and the reason
 * it is worth restating here is that composition is where it would be most tempting to trust the
 * caller: the agent has just been told these offers exist, so surely it can be trusted to describe
 * them. It cannot, and it should not have to be.
 */
export function buildPlanParts(
  requests: readonly PartRequest[],
  offers: readonly NormalizedOffer[],
): { parts: PlanPart[] } | { error: BuildPlanError } {
  const parts: PlanPart[] = [];
  const seenRoles = new Set<PlanPartRole>();

  for (const request of requests) {
    if (seenRoles.has(request.role)) {
      return { error: { reason: 'duplicate_role', role: request.role } };
    }
    seenRoles.add(request.role);

    const offer = offers.find(
      (o) => o.provider_id === request.provider_id && o.resource_id === request.resource_id,
    );
    if (!offer) return { error: { reason: 'unknown_part', request } };
    if (offer.role !== request.role) {
      return { error: { reason: 'role_mismatch', request, actualRole: offer.role } };
    }

    const part: PlanPart = {
      role: offer.role,
      provider_id: offer.provider_id,
      resource_id: offer.resource_id,
      support_kind: offer.support_kind,
      service_area: offer.service_area,
      capabilities: offer.capabilities,
      window: offer.window,
      ...(offer.admission !== undefined ? { admission: offer.admission } : {}),
      ...(offer.pickup_earliest !== undefined ? { pickup_earliest: offer.pickup_earliest } : {}),
      ...(offer.journey_minutes !== undefined ? { journey_minutes: offer.journey_minutes } : {}),
      ...(offer.arrival !== undefined ? { arrival: offer.arrival } : {}),
    };
    parts.push(part);
  }

  return { parts };
}

/**
 * Other offers in the same search that could fill a given role.
 *
 * Returned by plan-level `explain_gap` so the agent can re-check without a second fan-out. Less
 * traffic against organisations that did nothing wrong, and a faster conversation with the person.
 */
export function alternativesForRole(
  role: PlanPartRole,
  offers: readonly NormalizedOffer[],
  exclude: { provider_id: ProviderId; resource_id: string },
): Array<{ provider_id: ProviderId; resource_id: string; role: PlanPartRole }> {
  return offers
    .filter(
      (o) =>
        o.role === role &&
        o.units > 0 &&
        !(o.provider_id === exclude.provider_id && o.resource_id === exclude.resource_id),
    )
    .map((o) => ({ provider_id: o.provider_id, resource_id: o.resource_id, role: o.role }));
}
