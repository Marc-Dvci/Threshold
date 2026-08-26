/**
 * respite-a · the organisation's own backend.
 *
 * Holds the lease store, which is why it is a single process: every session that reaches this
 * provider contends for the same inventory. That is what makes the two-session collision real
 * rather than staged.
 */

import { parseServerArgs, startProviderServer } from '@threshold/provider-kit/server';
import { RESPITE_INVENTORY } from '@threshold/test-fixtures';

const args = parseServerArgs(process.argv.slice(2));

void startProviderServer({
  label: 'respite-a',
  inventory: RESPITE_INVENTORY,
  port: args.port ?? 6101,
  ...(args.apiOnly ? {} : args.staticDir ? { staticDir: args.staticDir } : {}),
  resetToken: process.env.THRESHOLD_RESET_TOKEN ?? 'demo-reset',
  ...(process.env.VITE_HUB_ORIGIN ? { hubOrigin: process.env.VITE_HUB_ORIGIN } : {}),
});
