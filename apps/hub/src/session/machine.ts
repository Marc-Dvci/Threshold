/**
 * The hub state machine. Build plan §13.
 *
 * Two jobs, and keeping them in one object is the point:
 *
 *  1. **It decides which tools the agent can see.** The tool surface is a function of state, so
 *     `place_plan_holds` does not exist before a feasible plan exists and `make_referral` does not
 *     exist before a lease does. An agent cannot call step three before step two, because step three
 *     is not in its list. That is order enforcement by construction rather than by validation, and
 *     it is a genuine platform capability worth showing on camera.
 *
 *  2. **It refuses transitions that do not exist.** A tool invoked in the wrong state returns
 *     `STATE_CONFLICT` with the current state named, deterministically.
 *
 * The correction from revision 1.0 (§13.3) lives in the second job. Concurrency control — stopping a
 * second `make_referral` while one consent panel is already open — is done here, by state, and *not*
 * by unregistering a tool during its own execution. Unregistering mid-execution is the exact Chrome
 * 153 edge, and a host agent watching a tool vanish mid-conversation can behave in ways no local
 * test reveals. A state check is deterministic and unit-testable; a platform edge is neither.
 */

import { HUB_TOOL_NAMES, type ErrorCode, type HubToolName } from '@threshold/contracts';

export type HubStateTag =
  | 'READY'
  | 'SEARCHED'
  | 'PLAN_COMPOSED'
  | 'PARTIALLY_HELD'
  | 'COMPENSATING'
  | 'HELD'
  | 'CONSENT_PENDING'
  | 'REFERRED';

/**
 * The state, plus the identifiers a UI needs to render it.
 *
 * Ids rather than objects: the data lives in `SessionStore`, and duplicating it here would create
 * two answers to "what is currently held" that could drift apart under a failed compensation.
 */
export type HubState = {
  tag: HubStateTag;
  search_id?: string;
  plan_id?: string;
  /** Leases the hub is responsible for right now, by hold id. */
  hold_ids: readonly string[];
  /** The lease a pending consent panel is about. */
  consent_hold_id?: string;
  referral_id?: string;
  /** Why compensation is running, when it is. */
  reason?: ErrorCode;
};

/** §13.3, verbatim. The one table that decides what an agent can see. */
export const TOOLS_BY_STATE: Readonly<Record<HubStateTag, readonly HubToolName[]>> = {
  READY: ['find_support'],
  SEARCHED: ['find_support', 'explain_gap', 'check_plan', 'place_hold'],
  PLAN_COMPOSED: ['find_support', 'explain_gap', 'check_plan', 'place_hold', 'place_plan_holds'],
  PARTIALLY_HELD: ['find_support', 'release_plan'],
  COMPENSATING: ['find_support'],
  HELD: ['find_support', 'release_hold', 'release_plan', 'make_referral'],
  CONSENT_PENDING: ['find_support', 'release_hold'],
  REFERRED: ['find_support', 'get_plan'],
};

/**
 * Which states each tool may be invoked from.
 *
 * Derived from the table above rather than written a second time, so the registration rule and the
 * rejection rule cannot disagree. A tool that is not registered in a state is also a tool that is
 * refused in that state, which matters because a host agent may hold a stale tool list.
 */
export const STATES_FOR_TOOL: Readonly<Record<HubToolName, readonly HubStateTag[]>> =
  Object.fromEntries(
    HUB_TOOL_NAMES.map((tool) => [
      tool,
      (Object.keys(TOOLS_BY_STATE) as HubStateTag[]).filter((tag) =>
        TOOLS_BY_STATE[tag].includes(tool),
      ),
    ]),
    // `Object.fromEntries` widens its key type to `string`, so the two-step assertion is the
    // honest way to state what the map actually is. The pairing is not taken on trust: the coverage
    // test asserts that every tool name in the registry appears as a key.
  ) as unknown as Record<HubToolName, readonly HubStateTag[]>;

export type StateListener = (state: HubState, previous: HubState) => void;

export class HubStateMachine {
  private state: HubState = { tag: 'READY', hold_ids: [] };
  private readonly listeners = new Set<StateListener>();

  current(): HubState {
    return this.state;
  }

  tag(): HubStateTag {
    return this.state.tag;
  }

  desiredTools(): readonly HubToolName[] {
    return TOOLS_BY_STATE[this.state.tag];
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * May this tool run right now?
   *
   * Returns the state name in the failure so the message a person reads can say where they are
   * rather than that something went wrong.
   */
  allows(tool: HubToolName): boolean {
    return TOOLS_BY_STATE[this.state.tag].includes(tool);
  }

  /**
   * Move to a new state.
   *
   * Deliberately not a table of legal (from, to) pairs. The legal transitions in §13.2 are a
   * consequence of which tool may run in which state, which is already enforced by `allows`, and a
   * second table would be a second thing to keep in step. What this method guarantees is that every
   * change is atomic and observed: listeners see a consistent state, once, with the previous one for
   * comparison.
   */
  transition(next: Partial<HubState> & { tag: HubStateTag }): HubState {
    const previous = this.state;
    this.state = {
      hold_ids: [],
      ...next,
    };
    for (const listener of this.listeners) listener(this.state, previous);
    return this.state;
  }

  /** Update the current state without changing its tag. Used when a lease list changes. */
  patch(patch: Partial<Omit<HubState, 'tag'>>): HubState {
    return this.transition({ ...this.state, ...patch, tag: this.state.tag });
  }
}

/**
 * The message an agent gets when it calls a tool from the wrong state.
 *
 * Names the state and the states the tool does work in, because an agent that is told only "no"
 * will retry, and an agent that is told where it is can recover in one step.
 */
export function stateConflictMessage(tool: HubToolName, tag: HubStateTag): string {
  const allowed = STATES_FOR_TOOL[tool];
  return (
    `${tool} is not available while the page is in ${tag}. ` +
    `It works in: ${allowed.join(', ')}.`
  );
}
