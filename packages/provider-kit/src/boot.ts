/**
 * The provider page.
 *
 * Each provider is a real, separate website belonging to a different organisation, and it has to
 * read as one. In the demo a second tab shows this page while the hub is taken offline from it, and
 * that shot only works if the page looks like something an organisation would actually run rather
 * than like a test harness with a button.
 *
 * Vanilla DOM, no framework. A provider page is a status board and a switch; adding a UI library
 * here would mean four more bundles for four pages that render one table each.
 */

import { ProviderHost } from '@threshold/webmcp-adapter';
import { environmentBlockers, isWebMCPSupported } from '@threshold/webmcp-adapter';

import { buildProviderTools, type ProviderConfig } from './tools';

/**
 * Where a demonstration flag lives so that every document of this origin agrees about it.
 *
 * A control on the provider's own page is thrown in a *tab*, and the document the hub has framed is
 * a different document. A flag in `localStorage` is shared by both, and a reload nudge on a
 * same-origin `BroadcastChannel` is how the framed copy finds out to pick it up. Both mechanisms are
 * same-origin by construction, which is the property that matters: one organisation cannot flip a
 * switch inside another.
 */
const DEMO_CHANNEL = 'threshold.provider.state';
const HOSTILE_KEY = 'threshold.demo.hostile';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Storage can be unavailable (private mode, blocked site data). A demonstration flag is not
    // worth an exception on boot.
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* nothing to do; the toggle simply will not persist */
  }
}

/** True when this origin has been asked to answer with a deliberately hostile payload. §46. */
export function hostileModeEnabled(): boolean {
  return readFlag(HOSTILE_KEY);
}

export type BootOptions = ProviderConfig & {
  hubOrigin: string;
  /** The organisation's line of business, for its own page. */
  strapline: string;
  /**
   * Whether the offline switch is shown.
   *
   * Behind a flag, for the same reason §29 protects the reset endpoint: a public button that takes a
   * care provider offline is not a thing to leave on a deployed page.
   */
  showControl?: boolean;
  /**
   * The token the organisation's own reset route expects.
   *
   * A speed bump, not a secret, and it is the provider's own: this page is same-origin with the
   * backend it is asking. The hub never sees it and could not use it if it did.
   */
  resetToken?: string;
};

const MAX_LOG_LINES = 60;

export function bootProvider(options: BootOptions): ProviderHost {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('no #app element');

  const log: string[] = [];
  const pushLog = (line: string) => {
    const at = new Date().toLocaleTimeString('en-GB', { hour12: false });
    log.unshift(`${at}  ${line}`);
    if (log.length > MAX_LOG_LINES) log.pop();
    renderLog();
  };

  const tools = buildProviderTools({ ...options, onActivity: pushLog });

  const host = new ProviderHost(tools, {
    hubOrigin: options.hubOrigin,
    onStateChange: (online) => {
      pushLog(online ? 'tools registered, accepting requests' : 'tools withdrawn, offline');
      renderStatus(online);
    },
  });

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  root.innerHTML = `
    <header class="masthead">
      <div class="org">
        <span class="mark" aria-hidden="true"></span>
        <div>
          <h1>${escapeHtml(options.displayName)}</h1>
          <p class="strapline">${escapeHtml(options.strapline)}</p>
        </div>
      </div>
      <div class="status" id="status" role="status"></div>
    </header>

    <main>
      <section aria-labelledby="conn-h">
        <h2 id="conn-h">Agent connection</h2>
        <dl class="facts">
          <dt>This origin</dt><dd><code>${escapeHtml(location.origin)}</code></dd>
          <dt>Tools exposed to</dt><dd><code>${escapeHtml(options.hubOrigin)}</code></dd>
          <dt>Tools published</dt><dd>${tools.map((t) => `<code>${escapeHtml(t.name)}</code>`).join(' ') || '<em>none</em>'}</dd>
          <dt>WebMCP in this browser</dt><dd id="webmcp-state"></dd>
        </dl>
        <p class="note">
          These tools are visible to one origin and no other. Nothing on this page is shared with the
          other organisations answering the same request.
        </p>
        ${
          options.availabilityOverride
            ? `<p class="note warn-note">
                 This organisation is currently answering with a deliberately hostile payload, for the
                 security demonstration. What it is sending is not shown here, and the coordinating
                 page will not show it either.
               </p>`
            : ''
        }
        ${
          options.showControl
            ? `<div class="control">
                 <button id="toggle" type="button" class="danger"></button>
                 <p class="note">
                   Withdraws this organisation's tools. The coordinating page finds out because the
                   tool set changed, not because a request failed. Every tab of this site follows,
                   including the one the coordinating page has framed.
                 </p>
                 <button id="hostile" type="button" class="danger">${
                   options.availabilityOverride
                     ? 'Stop answering with a hostile payload'
                     : 'Answer with a hostile payload'
                 }</button>
                 <p class="note">
                   Makes this organisation return a model instruction in a field the contract does not
                   have. Watch the coordinating page refuse it, name the rule, and print none of it.
                 </p>
                 <button id="reset" type="button">Restore seeded availability</button>
                 <p class="note">
                   Releases every hold and deletes every referral held by <em>this</em> organisation.
                   The coordinating page cannot do this: it reaches us over WebMCP, not by calling
                   our booking system.
                 </p>
               </div>`
            : ''
        }
      </section>

      <section aria-labelledby="inv-h">
        <h2 id="inv-h">Availability</h2>
        <table class="inventory">
          <thead>
            <tr><th scope="col">Ref</th><th scope="col">Kind</th><th scope="col">Window</th><th scope="col">Units</th><th scope="col">Holdable</th></tr>
          </thead>
          <tbody id="inventory-body"></tbody>
        </table>
      </section>

      <section aria-labelledby="log-h">
        <h2 id="log-h">Request log</h2>
        <p class="note">Requests received from the coordinating page. Field names only, never values.</p>
        <ol class="log" id="log" aria-live="polite"></ol>
      </section>
    </main>
  `;

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderStatus(online: boolean): void {
    const el = root!.querySelector<HTMLElement>('#status');
    if (el) {
      el.className = `status ${online ? 'online' : 'offline'}`;
      el.textContent = online ? 'Accepting requests' : 'Offline';
    }
    const toggle = root!.querySelector<HTMLButtonElement>('#toggle');
    if (toggle) {
      toggle.textContent = online ? 'Take this organisation offline' : 'Come back online';
      toggle.setAttribute('aria-pressed', String(!online));
    }
  }

  function renderLog(): void {
    const el = root!.querySelector<HTMLElement>('#log');
    if (!el) return;
    el.innerHTML = log.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  }

  function renderInventory(units: Record<string, number>): void {
    const body = root!.querySelector<HTMLElement>('#inventory-body');
    if (!body) return;
    body.innerHTML = options.inventory
      .map((offer) => {
        const left = units[offer.resource_id] ?? offer.units;
        const window =
          offer.support_kind === 'respite_bed'
            ? `admits to ${offer.admission.to.at}, D+${offer.admission.to.day}`
            : offer.support_kind === 'accessible_transport'
              ? `from ${offer.pickup_earliest.at}, ${offer.journey_minutes} min journey`
              : `${offer.window.from.at} to ${offer.window.to.at}`;
        return `<tr${left === 0 ? ' class="depleted"' : ''}>
          <th scope="row"><code>${escapeHtml(offer.resource_id)}</code></th>
          <td>${escapeHtml(offer.support_kind.replace(/_/g, ' '))}</td>
          <td>${escapeHtml(window)}</td>
          <td class="num">${left} of ${offer.units}</td>
          <td>${offer.holdable ? 'yes' : '<span class="muted">reference only</span>'}</td>
        </tr>`;
      })
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  const webmcpState = root.querySelector<HTMLElement>('#webmcp-state');
  if (webmcpState) {
    const blockers = environmentBlockers();
    if (isWebMCPSupported()) {
      webmcpState.textContent = 'available';
    } else if (blockers.length > 0) {
      webmcpState.textContent = `unavailable: ${blockers.join('; ')}`;
    } else {
      webmcpState.innerHTML =
        'not available in this browser. Tools are still answered over the ' +
        'same-origin bridge, so this organisation is reachable either way.';
    }
  }

  root.querySelector<HTMLButtonElement>('#toggle')?.addEventListener('click', () => {
    void host.toggle();
  });

  // The reload nudge. Every open document of this origin, including the one the coordinating page
  // has framed, comes back with the current demonstration flags.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DEMO_CHANNEL) : null;
  channel?.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { reload?: unknown })?.reload === true) location.reload();
  });

  root.querySelector<HTMLButtonElement>('#hostile')?.addEventListener('click', () => {
    writeFlag(HOSTILE_KEY, !hostileModeEnabled());
    channel?.postMessage({ reload: true });
    location.reload();
  });

  const refreshInventory = async () => {
    renderInventory(await options.api.units());
  };

  root.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
    // Same-origin, to this organisation's own backend, with the token. Build plan §29.
    void fetch('/api/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: options.resetToken ?? 'demo-reset' }),
    })
      .then((res) => pushLog(res.ok ? 'availability restored' : 'reset refused'))
      .then(() => refreshInventory());
  });

  void host.goOnline().then(async () => {
    renderStatus(host.isOnline());
    await refreshInventory();
  });

  // The provider's own page reflects its own store. Polling rather than pushing, because a provider
  // page is a dashboard and 4 seconds is plenty; a socket here would be infrastructure for nothing.
  setInterval(() => void refreshInventory(), 4000);

  return host;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
