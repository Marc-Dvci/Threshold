/**
 * Meadowbank Respite Unit  ·  provider origin `respite-a`
 *
 * An independent organisation. It publishes four tools to exactly one origin, keeps its own
 * inventory and its own lease store, and shares nothing with the other organisations answering the
 * same request. There is no code path from here to any of them.
 */

import '@threshold/provider-kit/provider.css';

import { bootProvider, createLeaseApiClient } from '@threshold/provider-kit';
import { RESPITE_INVENTORY } from '@threshold/test-fixtures';

const HUB_ORIGIN = import.meta.env.VITE_HUB_ORIGIN ?? 'http://localhost:5100';

// The offline control is behind a flag, for the same reason the reset endpoint is: a public button
// that takes a care provider offline is not something to leave on a deployed page.
const showControl = new URLSearchParams(location.search).has('control');

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
});
