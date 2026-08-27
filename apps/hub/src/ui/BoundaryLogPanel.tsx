/**
 * The data-boundary log. Build plan §16.4.
 *
 * The panel that makes the privacy design checkable instead of stated. A person can watch four typed
 * fields go to three organisations, watch each one answer, and watch nothing identifying go anywhere
 * until they press Send.
 *
 * The rule the panel inherits from `BoundaryLog` is that it renders **field names, never values**.
 * There is no code path from a referral value to this component, because `BoundaryLog` has no
 * parameter that could carry one. A log that printed what it logged about would itself be the
 * disclosure the rest of the system is arranged to prevent.
 */

import type { BoundaryEvent, BoundaryDirection } from '../audit/boundary-log';
import { displayNameFor } from '../broker/registry';

const DIRECTION_LABELS: Record<BoundaryDirection, string> = {
  agent_to_hub: 'assistant → page',
  hub_to_provider: 'page → organisation',
  provider_to_hub: 'organisation → page',
  hub_internal: 'inside the page',
  human: 'you',
};

export function BoundaryLogPanel({ events }: { events: readonly BoundaryEvent[] }) {
  return (
    <section aria-labelledby="log-h" className="panel log-panel">
      <h2 id="log-h">What crossed which boundary</h2>
      <p className="note">
        Every line is one of a fixed set this page owns. Field <em>names</em> are recorded; values
        never are.
      </p>
      {/*
        Focusable, because it scrolls. A scrollable region that cannot be reached by the keyboard is
        content a keyboard user simply cannot read, and this panel is where the privacy claim is
        made checkable. Caught by the axe audit in `tests/e2e/accessibility.spec.ts`.
      */}
      <ol
        className="boundary-log"
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Data boundary log, newest first"
      >
        {events.length === 0 && <li className="muted">Nothing has crossed a boundary yet.</li>}
        {events.map((event) => (
          <li key={event.seq} className={`event ${event.direction} ${event.severity}`}>
            <span className="at">{event.at}</span>
            <span className="dir">{DIRECTION_LABELS[event.direction]}</span>
            <span className="who">{event.provider ? displayNameFor(event.provider) : '—'}</span>
            <span className="what">
              {event.summary}
              {event.fields && event.fields.length > 0 && (
                <>
                  {' '}
                  <span className="fields">
                    [{event.fields.join(', ')}]
                    <span className="visually-hidden"> — field names only, no values</span>
                  </span>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
