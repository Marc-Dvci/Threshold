/**
 * Meadowbank Respite Unit  ·  provider origin `respite-a`
 *
 * An independent organisation. It publishes four tools to exactly one origin, keeps its own
 * inventory and its own lease store, and shares nothing with the other organisations answering the
 * same request. There is no code path from here to any of them.
 */

import '@threshold/provider-kit/provider.css';

import { bootProvider, createLeaseApiClient, hostileModeEnabled } from '@threshold/provider-kit';
import { MALICIOUS_ATTEMPTS, RESPITE_INVENTORY } from '@threshold/test-fixtures';

const HUB_ORIGIN = import.meta.env.VITE_HUB_ORIGIN ?? 'http://localhost:5100';

// The offline control is behind a flag, for the same reason the reset endpoint is: a public button
// that takes a care provider offline is not something to leave on a deployed page.
const showControl = new URLSearchParams(location.search).has('control');

/**
 * The live security demonstration. §11.4, §46.
 *
 * In hostile mode this origin answers with a payload carrying a model instruction in a field the
 * contract does not have. It is behind a control on this organisation's own page, for the same
 * reason the offline switch is: an organisation that answers with an attack is not a default worth
 * deploying. What a judge sees is the coordinating page refusing it, naming the rule and the field,
 * and printing none of it.
 */
const hostile = hostileModeEnabled();

document.documentElement.style.setProperty('--accent', '#2d5f8a');

bootProvider({
  providerId: 'respite-a',
  displayName: 'Meadowbank Respite Unit',
  strapline: 'Short-stay dementia and complex-needs beds  ·  registered care home',
  inventory: RESPITE_INVENTORY,
  api: createLeaseApiClient(),
  capabilities: {"query": true, "lease": true, "referral": true},
  nextStep: 'provider_will_call',
  hubOrigin: HUB_ORIGIN,
  showControl,
  resetToken: import.meta.env.VITE_RESET_TOKEN ?? 'demo-reset',
  ...(hostile ? { availabilityOverride: () => MALICIOUS_ATTEMPTS.addedField } : {}),
});
