/**
 * Boot convergence: an organisation that is still arriving is not an organisation offering less.
 *
 * These tests exist because of a bug that was found on the deployment and not by the suite. A
 * provider publishes its four tools with four separate async `registerTool` calls, so there is a
 * real window in which an origin is connected and publishing only the first of them. Discovery
 * landing inside that window produced a connected organisation with no `hold` and no
 * `accept_referral` — silently, with nothing logged and nothing thrown, on a different provider on
 * each reload. On free hosting, where each organisation is a service that sleeps when idle, the same
 * shape appears for tens of seconds at a time.
 *
 * The fixture below is a transport that hands out an origin's tools in stages, which is what a
 * partially-registered provider looks like from the hub's side of the boundary.
 */

import { describe, expect, it } from 'vitest';

import { ProviderBroker } from '../../apps/hub/src/broker/broker';
import { PROVIDERS } from '../../apps/hub/src/broker/registry';
import type {
  DiscoveredTool,
  ExecuteOutcome,
  OriginDiscovery,
  ProviderTransport,
} from '@threshold/webmcp-adapter';

const ALL_TOOLS = ['query_availability', 'hold', 'release_hold', 'accept_referral'] as const;

function tool(origin: string, name: string): DiscoveredTool {
  return { origin, name, handle: { name } as unknown as DiscoveredTool['handle'] };
}

/**
 * A transport where each origin needs `readyAfter` discoveries before it publishes everything.
 *
 * Before that it answers as a live origin with only `query_availability`, which is precisely the
 * failure mode: `state: 'ok'`, a real answer, an incomplete one.
 */
function stagedTransport(readyAfter: Record<string, number>): ProviderTransport & { calls: number } {
  let calls = 0;
  return {
    kind: 'webmcp',
    get calls() {
      return calls;
    },
    async discover(origins: readonly string[]): Promise<OriginDiscovery[]> {
      calls += 1;
      return origins.map((origin) => {
        const whole = calls >= (readyAfter[origin] ?? 1);
        const names = whole ? ALL_TOOLS : ALL_TOOLS.slice(0, 1);
        return {
          origin,
          state: 'ok',
          tools: names.map((n) => tool(origin, n)),
          ms: 0,
        } satisfies OriginDiscovery;
      });
    },
    async execute(): Promise<ExecuteOutcome> {
      return { state: 'failed', ms: 0, reason: 'not used by these tests' };
    },
  };
}

const origins = PROVIDERS.map((p) => p.origin);

describe('boot convergence', () => {
  it('a single refresh can report a whole organisation as publishing one tool', async () => {
    // The bug, pinned. If this ever stops holding, the staged fixture has stopped reproducing the
    // condition the rest of the file is about, and these tests would pass without proving anything.
    const transport = stagedTransport({ [origins[1]!]: 3 });
    const broker = new ProviderBroker(transport);

    const connections = await broker.refresh();
    const late = connections.find((c) => c.entry.origin === origins[1]);

    expect(late?.state).toBe('connected');
    expect(late?.missingTools).toEqual(['hold', 'release_hold', 'accept_referral']);
  });

  it('settle waits for every origin to publish its full contract', async () => {
    const transport = stagedTransport({ [origins[1]!]: 3, [origins[2]!]: 4 });
    const broker = new ProviderBroker(transport);

    const connections = await broker.settle({ budgetMs: 10_000 });

    expect(connections).toHaveLength(PROVIDERS.length);
    for (const c of connections) {
      expect(c.state).toBe('connected');
      expect(c.missingTools).toEqual([]);
      // `toConnection` sorts the names it reports, so compare against the sorted contract.
      expect(c.tools).toEqual([...ALL_TOOLS].sort());
    }
  });

  it('settle returns what it has when the budget expires rather than hanging', async () => {
    // One organisation that never finishes arriving must not decide whether the page loads at all.
    const transport = stagedTransport({ [origins[0]!]: Number.MAX_SAFE_INTEGER });
    const broker = new ProviderBroker(transport);

    const started = Date.now();
    const connections = await broker.settle({ budgetMs: 600 });

    expect(Date.now() - started).toBeLessThan(8000);
    expect(connections.find((c) => c.entry.origin === origins[0])?.missingTools).not.toEqual([]);
    // The others are still reported correctly; a slow origin does not blank the whole federation.
    expect(connections.find((c) => c.entry.origin === origins[1])?.missingTools).toEqual([]);
  });

  it('settling does not log a provider as having withdrawn', async () => {
    // A provider that had not started yet has not "withdrawn". Emitting that transition during boot
    // would write a false line into the boundary log on every cold visit.
    const withdrawals: string[] = [];
    const transport = stagedTransport({ [origins[1]!]: 3 });
    const broker = new ProviderBroker(transport, {
      onProviderWithdrew: (id) => withdrawals.push(id),
    });

    await broker.settle({ budgetMs: 10_000 });

    expect(withdrawals).toEqual([]);
  });
});
