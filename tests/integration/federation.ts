/**
 * An in-process federation, for testing the hub against real providers.
 *
 * The point of this harness is what it does **not** fake. It runs the real `buildProviderTools`
 * handlers, the real `LeaseStore` with its real atomicity and expiry, the real contracts, the real
 * trust firewall, the real orchestrator and the real consent controller. The only thing replaced is
 * the wire: instead of `executeTool` across an origin boundary, a `LoopbackTransport` calls the
 * provider's handler and returns the string it produced.
 *
 * That is the right seam. A test that stubbed provider *responses* would be testing the hub's
 * opinion of what a provider does; this tests what the provider actually does. The lease conflicts
 * in these tests are real conflicts in a real store, and the compensation really releases them.
 *
 * What it cannot test is the browser: `allow="tools"`, `exposedTo`, the `null`-on-navigation branch
 * and the argument-encoding latch are platform behaviours, and they belong to the runtime matrix in
 * `docs/RUNTIME_TEST_MATRIX.md` rather than to a Node test that could only assert its own mock.
 */

import type {
  ProviderHoldInput,
  ProviderId,
  ProviderOffer,
  ProviderReferralInput,
  ProviderReleaseInput,
} from '@threshold/contracts';
import { LeaseStore, type ResourceCapacity } from '@threshold/lease-store';
import {
  buildProviderTools,
  capacityFromInventory,
  type LeaseApiClient,
} from '@threshold/provider-kit';
import {
  HOMECARE_INVENTORY,
  RESPITE_INVENTORY,
  TRANSPORT_INVENTORY,
} from '@threshold/test-fixtures';
import type {
  DiscoveredTool,
  ExecuteOutcome,
  OriginDiscovery,
  ProviderToolDefinition,
  ProviderTransport,
} from '@threshold/webmcp-adapter';

import { PROVIDERS } from '../../apps/hub/src/broker/registry';

/**
 * The provider page's API client, wired straight to the store.
 *
 * Same interface the browser client implements, without the HTTP hop. The lease semantics under
 * test are the store's, and the store is the same object in both cases.
 */
function directClient(store: LeaseStore, capacity: readonly ResourceCapacity[]): LeaseApiClient {
  return {
    hold: async (input: ProviderHoldInput) => store.acquire(input),
    release: async (input: ProviderReleaseInput) => store.release(input.hold_id),
    referral: async (input: ProviderReferralInput) => store.convert(input),
    units: async () =>
      Object.fromEntries(capacity.map((c) => [c.resource_id, store.unitsLeft(c.resource_id)])),
  };
}

export type FakeProvider = {
  id: ProviderId;
  origin: string;
  store: LeaseStore;
  tools: ProviderToolDefinition[];
  /** Withdraw the tools, as the offline control does. §45. */
  online: boolean;
  /** Force every call to hang past the timeout, for the resilience tests. */
  hang: boolean;
  /** Return a payload the contract rejects, for the firewall tests. */
  corrupt: unknown | null;
  /**
   * Fired just before a call is dispatched to this provider.
   *
   * The seam that makes the awkward orchestration cases reachable: "the clock passed the TTL while
   * the next leg was being asked for", "the first organisation went offline part way through the
   * unwind". Both are ordinary in production and impossible to arrange from outside without a hook
   * that runs *during* a fan-out rather than between two of them.
   */
  onCall: ((tool: string, input: unknown) => void) | null;
  activity: string[];
};

export type Federation = {
  providers: Map<string, FakeProvider>;
  transport: ProviderTransport;
  byId: (id: ProviderId) => FakeProvider;
  reset: () => void;
};

const INVENTORIES: Record<string, readonly ProviderOffer[]> = {
  'respite-a': RESPITE_INVENTORY,
  'homecare-a': HOMECARE_INVENTORY,
  'transport-a': TRANSPORT_INVENTORY,
};

export function createFederation(
  options: { maxTtlSeconds?: number; now?: () => number } = {},
): Federation {
  const providers = new Map<string, FakeProvider>();

  for (const entry of PROVIDERS) {
    const inventory = INVENTORIES[entry.id] ?? [];
    const capacity = capacityFromInventory(inventory);
    const store = new LeaseStore(capacity, {
      ...(options.maxTtlSeconds !== undefined ? { maxTtlSeconds: options.maxTtlSeconds } : {}),
      ...(options.now ? { now: options.now } : {}),
      mintId: mintFor(entry.id),
    });
    const activity: string[] = [];

    const provider: FakeProvider = {
      id: entry.id,
      origin: entry.origin,
      store,
      online: true,
      hang: false,
      corrupt: null,
      onCall: null,
      activity,
      tools: buildProviderTools({
        providerId: entry.id,
        displayName: entry.displayName,
        inventory,
        api: directClient(store, capacity),
        capabilities: { query: true, lease: true, referral: true },
        nextStep: 'provider_will_call',
        onActivity: (line) => activity.push(line),
      }),
    };
    providers.set(entry.origin, provider);
  }

  const transport: ProviderTransport = {
    kind: 'webmcp',

    async discover(origins): Promise<OriginDiscovery[]> {
      return origins.map((origin) => {
        const provider = providers.get(origin);
        if (!provider || !provider.online) {
          // An offline provider publishes nothing. The hub finds out because the tool set changed,
          // which is what makes §45 a demonstration rather than an error path.
          return { origin, state: 'ok', tools: [], ms: 1 };
        }
        return {
          origin,
          state: 'ok',
          ms: 1,
          tools: provider.tools.map(
            (t): DiscoveredTool => ({
              origin,
              name: t.name,
              handle: { name: t.name } as RegisteredTool,
              description: t.description,
            }),
          ),
        };
      });
    },

    async execute(tool, input, execOptions = {}): Promise<ExecuteOutcome> {
      const provider = providers.get(tool.origin);
      if (!provider) return { state: 'failed', ms: 1, reason: 'no such origin' };
      provider.onCall?.(tool.name, input);
      if (!provider.online) {
        return { state: 'failed', ms: 1, reason: 'provider is offline' };
      }
      if (provider.hang) return { state: 'timeout', ms: execOptions.timeoutMs ?? 2000 };
      if (execOptions.signal?.aborted) return { state: 'aborted', ms: 0 };
      if (provider.corrupt !== null) {
        return { state: 'ok', ms: 1, raw: JSON.stringify(provider.corrupt) };
      }

      const def = provider.tools.find((t) => t.name === tool.name);
      if (!def) return { state: 'failed', ms: 1, reason: `no such tool: ${tool.name}` };

      const value = await def.execute(input, { signal: new AbortController().signal });
      return { state: 'ok', ms: 1, raw: JSON.stringify(value) };
    },
  };

  return {
    providers,
    transport,
    byId: (id) => {
      const found = [...providers.values()].find((p) => p.id === id);
      if (!found) throw new Error(`no fake provider ${id}`);
      return found;
    },
    reset: () => {
      for (const provider of providers.values()) {
        const inventory = INVENTORIES[provider.id] ?? [];
        provider.store.reset(capacityFromInventory(inventory));
        provider.online = true;
        provider.hang = false;
        provider.corrupt = null;
        provider.onCall = null;
        provider.activity.length = 0;
      }
    },
  };
}

/**
 * Deterministic identifiers, per provider.
 *
 * Prefixed by provider so a hold id in a failing assertion says which organisation granted it. A
 * test that reports `hold_000003` and leaves you to work out whose it was is a test that costs an
 * hour on the day it fails.
 */
function mintFor(id: ProviderId): (prefix: 'hold' | 'ref') => string {
  let n = 0;
  const tag = id.replace(/[^a-z]/g, '').slice(0, 4);
  return (prefix) => {
    n += 1;
    return `${prefix}_${tag}${String(n).padStart(6, '0')}`;
  };
}
