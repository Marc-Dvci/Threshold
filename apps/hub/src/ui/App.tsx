/**
 * The hub page. Build plan §19.
 *
 * A status board, not an application. Threshold has no search box, no filters and no chat: the
 * person's own agent is the conversational interface, and this page's job is to show them what their
 * agent is doing on their behalf, to whom, and what has crossed which boundary.
 *
 * That is why the two largest panels are the plan and the boundary log. Everything a competitor's
 * demo would put in the middle of the screen — the search form — does not exist here, because it is
 * the agent's.
 */

import {
  LINK_LABELS,
  formatInstant,
  shortInstant,
  type LinkKind,
} from '@threshold/contracts';

import type { HubApp } from '../app/hub-app';
import { displayNameFor } from '../broker/registry';
import { BoundaryLogPanel } from './BoundaryLogPanel';
import { ConsentPanel } from './ConsentPanel';
import { PlanDocument } from './PlanDocument';
import { SecurityPanel } from './SecurityPanel';
import { formatCountdown, useBoundaryLog, useConsent, useHubView, useNow } from './hooks';

const STATE_CAPTIONS: Record<string, string> = {
  READY: 'Waiting for your assistant to ask.',
  SEARCHED: 'Organisations have answered. Nothing is held.',
  PLAN_COMPOSED: 'A plan fits together. Nothing is held yet.',
  PARTIALLY_HELD: 'Taking leases, one organisation at a time.',
  COMPENSATING: 'A leg was refused. Releasing everything already held.',
  HELD: 'Leases are running. Nothing identifying has been sent.',
  CONSENT_PENDING: 'Waiting for you to review what is about to be sent.',
  REFERRED: 'Referred. The organisation has your details.',
};

export function App({ hub }: { hub: HubApp }) {
  const showControls =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('control');
  const view = useHubView(hub);
  const consent = useConsent(hub);
  const events = useBoundaryLog(hub);
  const now = useNow();

  const search = hub.store.currentSearch();
  const plan = view.state.plan_id ? hub.store.plan(view.state.plan_id) : undefined;
  const leases = hub.store.allLeases();
  const referral = view.state.referral_id ? hub.store.referral(view.state.referral_id) : undefined;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the plan
      </a>

      <header className="masthead">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Threshold</h1>
            <p className="strapline">
              Several care organisations answer your assistant at once, and compose one plan between
              them.
            </p>
          </div>
        </div>
        <div className="runtime" role="status">
          <TransportBadge kind={view.transport} ready={view.ready} />
          <p className="state">
            <strong>{view.state.tag}</strong> · {STATE_CAPTIONS[view.state.tag] ?? ''}
          </p>
        </div>
      </header>

      <main id="main">
        <section aria-labelledby="providers-h" className="panel">
          <h2 id="providers-h">Organisations</h2>
          <p className="note">
            Four separate websites, on four origins, each with its own inventory and its own booking
            system. None of them can see the others.
          </p>
          <ul className="providers">
            {view.connections.map((c) => (
              <li key={c.entry.id} className={`provider ${c.state}`}>
                <h3>{c.entry.displayName}</h3>
                <p className="origin">
                  <code>{c.entry.origin}</code>
                </p>
                <p className="conn">
                  <span className={`dot ${c.state}`} aria-hidden="true" />
                  {c.state === 'connected'
                    ? `connected · ${c.tools.length} tools · ${c.ms}ms`
                    : c.state === 'timeout'
                      ? 'did not answer in time'
                      : 'not reachable'}
                </p>
                {c.state === 'connected' && c.missingTools.length > 0 && (
                  <p className="warn">does not publish: {c.missingTools.join(', ')}</p>
                )}
                <p className="attest">
                  {c.entry.assertionClass === 'directory_attested'
                    ? 'capabilities recorded by a public directory'
                    : 'capabilities asserted by the organisation'}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="tools-h" className="panel">
          <h2 id="tools-h">What your assistant can do right now</h2>
          <p className="note">
            The tool list changes with the state of the page. A step that is not yet possible is not
            merely refused — it does not exist for the assistant to call.
          </p>
          <ul className="tools" aria-live="polite">
            {view.registeredTools.length === 0 && (
              <li className="muted">
                No tools registered. This browser did not expose WebMCP to the page.
              </li>
            )}
            {view.registeredTools.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </section>

        {search && (
          <section aria-labelledby="need-h" className="panel">
            <h2 id="need-h">What was asked for</h2>
            <p className="note">
              Typed capabilities only. There is no field on this page in which a person's story can
              be written down, and none in which one could be sent.
            </p>
            <ul className="need">
              <li>
                area <strong>{search.need.service_area}</strong>
              </li>
              <li>
                needs <strong>{search.need.support_kinds.join(', ')}</strong>
              </li>
              <li>
                starts within <strong>{search.need.starts_within_hours}h</strong>
              </li>
              <li>
                for <strong>{search.need.duration_hours}h</strong>
              </li>
              <li>
                in place by <strong>{formatInstant(search.need.deadline)}</strong>
              </li>
              {search.need.dementia_trained && <li>dementia-trained staff</li>}
              {search.need.wheelchair_access && <li>wheelchair access</li>}
              {search.need.hoist_required && <li>hoist</li>}
              {search.need.same_gender_staff_required && <li>same-gender staff</li>}
              {search.need.accepts_pets_required && <li>a pet</li>}
              <li>
                speaking <strong>{search.need.spoken_language}</strong>
              </li>
            </ul>
          </section>
        )}

        {search && (
          <section aria-labelledby="matches-h" className="panel">
            <h2 id="matches-h">What came back</h2>
            <table className="matches">
              <caption className="visually-hidden">
                Offers returned by each organisation, with any lease currently held.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ref</th>
                  <th scope="col">Organisation</th>
                  <th scope="col">Role</th>
                  <th scope="col">Window</th>
                  <th scope="col">Left</th>
                  <th scope="col">Hold</th>
                </tr>
              </thead>
              <tbody>
                {search.exact.map((offer) => {
                  const lease = leases.find(
                    (l) => l.resource_id === offer.resource_id && l.provider_id === offer.provider_id,
                  );
                  return (
                    <tr key={`${offer.provider_id}:${offer.resource_id}`}>
                      <th scope="row">
                        <code>{offer.resource_id}</code>
                      </th>
                      <td>{displayNameFor(offer.provider_id)}</td>
                      <td>{offer.role}</td>
                      <td>
                        {shortInstant(offer.window.from)} → {shortInstant(offer.window.to)}
                        {offer.arrival && <> · arrives {offer.arrival.at}</>}
                        {offer.admission && <> · admits to {offer.admission.to.at}</>}
                      </td>
                      <td className="num">{offer.units}</td>
                      <td>
                        {lease ? (
                          <span className="countdown">
                            {formatCountdown(lease.expires_at_epoch_ms, now)}
                          </span>
                        ) : offer.holdable ? (
                          <span className="muted">available</span>
                        ) : (
                          <span className="muted">reference only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {search.exact.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Nothing matched every requirement.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {search.nearMisses.length > 0 && (
              <>
                <h3>Close, but not quite</h3>
                <ul className="near">
                  {search.nearMisses.map((offer) => (
                    <li key={`${offer.provider_id}:${offer.resource_id}`}>
                      <code>{offer.resource_id}</code> at {displayNameFor(offer.provider_id)} — ask
                      your assistant why, and it can tell you exactly which requirement it misses.
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {plan && (
          <section aria-labelledby="plan-h" className="panel plan-panel">
            <h2 id="plan-h">The plan, checked between organisations</h2>
            <p className={plan.result.feasible ? 'verdict ok' : 'verdict bad'}>
              {plan.result.feasible
                ? 'Every link holds. These parts fit each other.'
                : 'These parts do not fit each other.'}
            </p>
            <ol className="links">
              {plan.result.links.map((link, index) => (
                <li key={`${link.kind}-${index}`} className={link.ok ? 'link ok' : 'link bad'}>
                  <span className="link-mark" aria-hidden="true">
                    {link.ok ? '✓' : '✗'}
                  </span>
                  <span className="link-body">
                    <strong>{LINK_LABELS[link.kind as LinkKind]}</strong>
                    {!link.ok && (
                      <>
                        <br />
                        needs <code>{link.required}</code>, offered <code>{link.offered}</code>
                        <br />
                        go back to <strong>{displayNameFor(link.renegotiate_with)}</strong>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {plan.result.missingRoles.length > 0 && (
              <p className="warn">
                The plan has no {plan.result.missingRoles.join(' and no ')} yet.
              </p>
            )}
          </section>
        )}

        {referral && <PlanDocument receipt={referral} />}

        <SecurityPanel session={search} />

        <BoundaryLogPanel events={events} />
      </main>

      <footer className="page-foot">
        <p>
          Threshold holds nothing. Everything on this page came from another origin, through a
          validator, and lives only until you close the tab.
        </p>
        <p>
          <a href="/verify.html">Verify the federation in this browser</a>
        </p>
        {showControls && (
          <p>
            {/*
              Behind a query flag, for the same reason the providers' offline switches are: a public
              button that empties three care organisations' diaries is not something to leave on a
              deployed page (§29). It exists because a demo that starts from dirty state fails on the
              day, and re-recording a take should not mean restarting seven processes.
            */}
            <button type="button" className="secondary" onClick={() => void resetSession(hub)}>
              Forget this session
            </button>{' '}
            <span className="note">
              Clears the search, the plan and the log on this page. Each organisation restores its own
              inventory from its own page, because this page is not in charge of theirs.
            </span>
          </p>
        )}
      </footer>

      {consent && <ConsentPanel view={consent} controller={hub.consent} />}
    </>
  );
}

/**
 * Which wire is actually in use, said plainly. Invariant L.
 *
 * The `postMessage` path is never presented as WebMCP federation. It is genuinely cross-origin,
 * which is the accurate thing to say about it, and saying so is worth more than the claim it would
 * replace.
 */
function TransportBadge({ kind, ready }: { kind: 'webmcp' | 'postmessage' | 'none'; ready: boolean }) {
  if (!ready) return <p className="transport pending">connecting to organisations…</p>;
  if (kind === 'webmcp') {
    return (
      <p className="transport webmcp">
        <strong>WebMCP federation</strong> · cross-origin tools, discovered and executed by this page
      </p>
    );
  }
  if (kind === 'postmessage') {
    return (
      <p className="transport fallback">
        <strong>Same-origin bridge, not WebMCP federation.</strong> This browser did not expose
        cross-origin tool discovery to the page, so the same provider origins are being reached over
        a typed <code>postMessage</code> protocol instead.
      </p>
    );
  }
  return <p className="transport fallback">No transport available.</p>;
}

/**
 * Forget this session. §29.
 *
 * The hub's half of a demo reset, and only its half. It does **not** reach into the organisations'
 * inventories, because it cannot and must not: the hub talks to providers over WebMCP or the bridge,
 * never by calling their HTTP APIs across origins (§23.8). A hub that could POST to three booking
 * systems to tidy up after itself would have quietly stopped being a federation.
 *
 * Each organisation has its own reset, on its own page, under the same query flag. That is one more
 * click per origin and one less lie about who is in charge of what.
 */
async function resetSession(hub: HubApp): Promise<void> {
  await hub.reset();
}
