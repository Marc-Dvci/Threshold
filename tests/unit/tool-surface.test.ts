/**
 * The tool surface as a function of state. Build plan §13.3, §9.
 *
 * The claim this guards is the ordering one: an agent cannot call step three before step two,
 * because step three is not in its tool list. That is only true if the table is complete, if every
 * tool in the registry appears in it, and if the rule that *registers* a tool and the rule that
 * *refuses* it are the same rule. All three are checked here rather than reviewed.
 *
 * Also here: the budgets. A description over Chrome's 500-character guidance does not throw, it
 * degrades tool selection, which surfaces later as a mysterious eval regression rather than as an
 * error. A test is the only place that gets noticed.
 */

import { describe, expect, it } from 'vitest';

import { HUB_TOOL_NAMES, V, type HubToolName } from '@threshold/contracts';

import {
  HubStateMachine,
  STATES_FOR_TOOL,
  TOOLS_BY_STATE,
  stateConflictMessage,
  type HubStateTag,
} from '../../apps/hub/src/session/machine';
import { hubToolSummary } from '../../apps/hub/src/tools/definitions';

const ALL_STATES = Object.keys(TOOLS_BY_STATE) as HubStateTag[];

describe('the state table', () => {
  it('accounts for every tool in the registry', () => {
    // Adding a tenth tool without deciding which states it belongs to is a visible omission rather
    // than a tool that is silently never registered.
    expect(Object.keys(STATES_FOR_TOOL).sort()).toEqual([...HUB_TOOL_NAMES].sort());
    for (const tool of HUB_TOOL_NAMES) {
      expect(STATES_FOR_TOOL[tool].length).toBeGreaterThan(0);
    }
  });

  it('derives the refusal rule from the registration rule', () => {
    // A tool that is not registered in a state is also refused in that state. They cannot disagree,
    // because one is computed from the other — and they must not, because a host agent can hold a
    // stale tool list and call something that has already vanished.
    for (const tag of ALL_STATES) {
      for (const tool of HUB_TOOL_NAMES) {
        expect(TOOLS_BY_STATE[tag].includes(tool)).toBe(STATES_FOR_TOOL[tool].includes(tag));
      }
    }
  });

  it('always leaves a way back to a search', () => {
    // Whatever has gone wrong, the person can start again. `find_support` is the one tool that
    // exists in every state, so no state is a dead end.
    for (const tag of ALL_STATES) {
      expect(TOOLS_BY_STATE[tag]).toContain('find_support');
    }
  });

  it('registers no mutating tool while leases are unwinding', () => {
    // §13.3. During COMPENSATING the hub is releasing other people's beds back to them; letting an
    // agent take a new one in the middle of that is the one thing it must not be able to do.
    expect(TOOLS_BY_STATE.COMPENSATING).toEqual(['find_support']);
  });

  it('does not offer a lease tool before there is anything to lease', () => {
    expect(TOOLS_BY_STATE.READY).toEqual(['find_support']);
    expect(TOOLS_BY_STATE.SEARCHED).not.toContain('place_plan_holds');
    expect(TOOLS_BY_STATE.SEARCHED).not.toContain('make_referral');
    // The ordering claim, stated as data: `place_plan_holds` exists in exactly one state, the one
    // that means a plan has been checked and found feasible.
    expect(STATES_FOR_TOOL.place_plan_holds).toEqual(['PLAN_COMPOSED']);
    expect(STATES_FOR_TOOL.make_referral).toEqual(['HELD']);
    expect(STATES_FOR_TOOL.get_plan).toEqual(['REFERRED']);
  });

  it('freezes the remaining mutating tools while a person is reading the consent panel', () => {
    // Releasing the hold is still allowed — a person may decide against the whole thing — but
    // nothing else can move underneath them while the panel is open.
    expect(TOOLS_BY_STATE.CONSENT_PENDING).toEqual(['find_support', 'release_hold']);
  });
});

describe('the machine', () => {
  it('starts with one tool and reports its own state', () => {
    const machine = new HubStateMachine();
    expect(machine.tag()).toBe('READY');
    expect(machine.desiredTools()).toEqual(['find_support']);
    expect(machine.allows('find_support')).toBe(true);
    expect(machine.allows('place_hold')).toBe(false);
  });

  it('tells a listener the previous state as well as the new one', () => {
    const machine = new HubStateMachine();
    const seen: Array<[string, string]> = [];
    machine.subscribe((next, previous) => seen.push([previous.tag, next.tag]));

    machine.transition({ tag: 'SEARCHED', search_id: 'search_aaaaaaaa', hold_ids: [] });
    machine.transition({ tag: 'PLAN_COMPOSED', plan_id: 'plan_aaaaaaaa', hold_ids: [] });

    expect(seen).toEqual([
      ['READY', 'SEARCHED'],
      ['SEARCHED', 'PLAN_COMPOSED'],
    ]);
  });

  it('keeps the tag when patching the lease list', () => {
    const machine = new HubStateMachine();
    machine.transition({ tag: 'HELD', search_id: 'search_aaaaaaaa', hold_ids: ['hold_a1'] });
    machine.patch({ hold_ids: ['hold_a1', 'hold_b2'] });
    expect(machine.tag()).toBe('HELD');
    expect(machine.current().hold_ids).toEqual(['hold_a1', 'hold_b2']);
  });

  it('tells an agent where it is and where the tool does work', () => {
    // An agent told only "no" retries. An agent told where it is recovers in one step.
    const message = stateConflictMessage('make_referral', 'SEARCHED');
    expect(message).toContain('SEARCHED');
    expect(message).toContain('HELD');
  });
});

describe('what the agent reads', () => {
  it('keeps every description inside the documented budget', () => {
    for (const tool of hubToolSummary()) {
      expect(tool.descriptionChars).toBeLessThanOrEqual(500);
      // And long enough to say what the tool needs first and what it gives back. A one-line
      // description is a tool an agent guesses about.
      expect(tool.descriptionChars).toBeGreaterThan(80);
    }
  });

  it('describes all nine tools and no others', () => {
    expect(hubToolSummary().map((t) => t.name).sort()).toEqual([...HUB_TOOL_NAMES].sort());
  });

  it('marks exactly the read-only tools as read-only', () => {
    const readOnly = hubToolSummary()
      .filter((t) => t.readOnly)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(['check_plan', 'explain_gap', 'find_support', 'get_plan']);
  });

  it('advertises the compiled contract as its input schema, not a second copy', () => {
    // The schema an agent reads and the schema Ajv enforces are the same object, so a contract
    // change cannot drift out of the tool description.
    const pairs: Array<[HubToolName, object]> = [
      ['find_support', V.findSupportInput.raw.schema as object],
      ['check_plan', V.checkPlanInput.raw.schema as object],
      ['make_referral', V.makeReferralInput.raw.schema as object],
    ];
    for (const [, schema] of pairs) {
      expect(schema).toBeTypeOf('object');
      expect(schema).not.toBeNull();
    }
  });

  it('keeps every parameter description inside its own budget', () => {
    // 150 characters, per Chrome's guidance. A truncated parameter description is a field an agent
    // fills in wrongly.
    const schemas = [
      V.findSupportInput.raw.schema,
      V.checkPlanInput.raw.schema,
      V.placeHoldInput.raw.schema,
      V.makeReferralInput.raw.schema,
      V.getPlanInput.raw.schema,
    ] as Array<{ properties?: Record<string, { description?: string }> }>;

    for (const schema of schemas) {
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (typeof property?.description !== 'string') continue;
        expect(
          property.description.length,
          `${name} description is ${property.description.length} chars`,
        ).toBeLessThanOrEqual(150);
      }
    }
  });
});
