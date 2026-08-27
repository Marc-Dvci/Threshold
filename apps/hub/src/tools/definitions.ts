/**
 * The nine tools as WebMCP declares them. Build plan §9, §24.
 *
 * The only file in the hub that knows what a `ModelContextTool` is. Everything below it returns
 * `ToolResult` and everything above it is React, so a change in how a browser wants tool results
 * shaped touches this file and nowhere else.
 *
 * **Descriptions are the product here, not documentation.** An agent picks a tool by reading these
 * strings, so each one says what the tool *does*, what it *needs first*, and what it *gives back* —
 * in that order, under the 500-character budget Chrome documents. A description that overruns is not
 * an error; it is a tool that gets selected less reliably, which then shows up as a mysterious eval
 * regression rather than as a failure. `registerWebMCPTool` records the overrun so it is visible.
 *
 * **`untrustedContentHint: false` is a claim, and it is checked.** It is honest only because no
 * provider-authored free string can reach these results: the firewall validates against schemas that
 * have no unconstrained string in them, and `tests/security/no-free-form-surface.test.ts` fails if
 * one is ever added. If that test is ever weakened, this flag must change with it.
 */

import { V, type HubToolName } from '@threshold/contracts';
import { encodeToolResult, type ToolDefinition } from '@threshold/webmcp-adapter';

import type { HubCore } from './core';

/**
 * What each tool tells the agent about itself.
 *
 * Kept beside each other rather than next to their handlers on purpose: an agent reads all nine at
 * once and chooses between them, so they have to be written as a set. Reading them in one column is
 * how you notice that two of them sound like the same tool.
 */
const DESCRIPTIONS: Record<HubToolName, { title: string; description: string }> = {
  find_support: {
    title: 'Find support',
    description:
      'Ask every care organisation connected to this page, at the same time, what it has available ' +
      'for a typed set of needs. Returns matching offers, near misses, and which organisations ' +
      'answered. Ask for every kind of support the situation needs in one call: a respite bed, ' +
      'transport to it, and overnight cover at home are usually one plan, not three searches.',
  },
  explain_gap: {
    title: 'Explain a gap',
    description:
      'Ask why something does not work. Given a resource_id, returns which of the stated ' +
      'requirements that offer fails. Given a plan_id, returns which links between organisations ' +
      'fail and which organisation to renegotiate with. Every answer is computed, not inferred, and ' +
      'names the field, what was required and what was offered.',
  },
  check_plan: {
    title: 'Check a plan',
    description:
      'Check whether a combination of offers from different organisations actually fits together: ' +
      'does the transport arrive before the bed stops admitting, is there a hoist at both ends, does ' +
      'overnight cover last until collection. Returns feasible or the failing links. Run this before ' +
      'holding anything.',
  },
  place_hold: {
    title: 'Hold one resource',
    description:
      'Place a short lease on a single resource from the current search results. The organisation ' +
      'itself decides whether it can be held and for how long. Use place_plan_holds instead when the ' +
      'person needs several parts that depend on each other.',
  },
  place_plan_holds: {
    title: 'Hold every part of a plan',
    description:
      'Lease every part of a feasible plan, one organisation at a time, scarcest first. All of them ' +
      'or none: if any leg is refused, every lease already taken is released before this returns, so ' +
      'nothing is left held against a plan that cannot happen. Only available once check_plan has ' +
      'returned feasible.',
  },
  release_hold: {
    title: 'Release a hold',
    description:
      'Give back one lease so the resource is available to someone else. Safe to call more than ' +
      'once; a lease that has already lapsed reports as expired rather than failing.',
  },
  release_plan: {
    title: 'Release a whole plan',
    description:
      'Give back every lease held for a plan, in reverse order, so the scarcest resource is freed ' +
      'last. Safe to call on a plan that holds nothing.',
  },
  make_referral: {
    title: 'Send a referral',
    description:
      'Propose the identifying details for a referral against a lease. This does not send anything ' +
      'by itself: it shows the exact fields to the person, who can change any of them, and waits. ' +
      'The call stays pending until they press Send or Cancel, which may be a while. Do not retry ' +
      'it, and do not tell the person it has been sent until this returns.',
  },
  get_plan: {
    title: 'Get the agreed plan',
    description:
      'Return the plan that was referred: which organisation holds which part, when each part runs, ' +
      'and what happens next. Use it to tell the person what has been arranged.',
  },
};

/** The input schema each tool advertises, taken from the compiled contract rather than re-written. */
const SCHEMAS: Record<HubToolName, object> = {
  find_support: V.findSupportInput.raw.schema as object,
  explain_gap: V.explainGapInput.raw.schema as object,
  check_plan: V.checkPlanInput.raw.schema as object,
  place_hold: V.placeHoldInput.raw.schema as object,
  place_plan_holds: V.placePlanHoldsInput.raw.schema as object,
  release_hold: V.releaseHoldInput.raw.schema as object,
  release_plan: V.releasePlanInput.raw.schema as object,
  make_referral: V.makeReferralInput.raw.schema as object,
  get_plan: V.getPlanInput.raw.schema as object,
};

/**
 * Annotations.
 *
 * `readOnlyHint` is about whether the call changes anything at an organisation, not whether it
 * changes anything in this page. `make_referral` additionally carries no `idempotentHint`, because
 * it emphatically is not: calling it twice asks a person to consent twice.
 */
const ANNOTATIONS: Record<HubToolName, ModelContextToolAnnotations> = {
  find_support: { readOnlyHint: true, untrustedContentHint: false },
  explain_gap: { readOnlyHint: true, untrustedContentHint: false },
  check_plan: { readOnlyHint: true, untrustedContentHint: false },
  place_hold: { readOnlyHint: false, untrustedContentHint: false },
  place_plan_holds: { readOnlyHint: false, untrustedContentHint: false },
  release_hold: { readOnlyHint: false, untrustedContentHint: false, idempotentHint: true },
  release_plan: { readOnlyHint: false, untrustedContentHint: false, idempotentHint: true },
  make_referral: { readOnlyHint: false, untrustedContentHint: false, destructiveHint: false },
  get_plan: { readOnlyHint: true, untrustedContentHint: false },
};

/**
 * Build the definitions the lifecycle manager registers and unregisters.
 *
 * `guard` wraps every handler so the lifecycle knows when it is inside an execution and can refuse a
 * reconcile from within one. That is the §13.3 correction made enforceable rather than remembered:
 * unregistering a tool during its own execution is the Chrome 153 edge, and the way to not do it by
 * accident is to make doing it throw.
 */
export function buildHubToolDefinitions(
  core: HubCore,
  options: { guard: <T>(fn: () => Promise<T>) => Promise<T> },
): ToolDefinition[] {
  return (Object.keys(DESCRIPTIONS) as HubToolName[]).map((name) => ({
    tool: {
      name,
      title: DESCRIPTIONS[name].title,
      description: DESCRIPTIONS[name].description,
      inputSchema: SCHEMAS[name],
      annotations: ANNOTATIONS[name],
      execute: (input, context) =>
        options.guard(async () => {
          const result = await core.handler(name)(input, { signal: context.signal });
          return encodeToolResult(result);
        }),
    },
  }));
}

/** Exported so `/verify` and the docs can print the surface without registering it. */
export function hubToolSummary(): Array<{
  name: HubToolName;
  title: string;
  descriptionChars: number;
  readOnly: boolean;
}> {
  return (Object.keys(DESCRIPTIONS) as HubToolName[]).map((name) => ({
    name,
    title: DESCRIPTIONS[name].title,
    descriptionChars: DESCRIPTIONS[name].description.length,
    readOnly: ANNOTATIONS[name].readOnlyHint === true,
  }));
}
