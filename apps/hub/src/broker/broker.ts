/**
 * The cross-origin broker. Build plan §21.
 *
 * Everything the hub knows about another organisation arrives through this class. It owns the
 * discovery index, the outbound validation, the execution wrapper and the firewall, in that order,
 * so that the sequence in §11.2 is a property of the code path rather than a convention four call
 * sites are each expected to remember.
 *
 * Two decisions that are not obvious from the outside:
 *
 *  - **Discovery is indexed by `(origin, name)`, never by name.** Three organisations each
 *    publishing a tool called `hold` is the normal case in a federation, not an edge case, and a
 *    flat name index would silently route one organisation's lease request to another's ward.
 *
 *  - **The transport is injected.** The broker does not know whether it is speaking WebMCP or the
 *    same-origin bridge, which is what keeps the fallback honest: there is one code path above the
 *    transport interface, so the trust firewall, the leases and the consent gate are identical
 *    either way (§47.2, Invariant L).
 */

import {
  V,
  type ProviderAvailability,
  type ProviderHoldInput,
  type ProviderHoldOutput,
  type ProviderId,
  type ProviderQuery,
  type ProviderReferralInput,
  type ProviderReferralOutput,
  type ProviderReleaseInput,
  type ProviderReleaseOutput,
} from '@threshold/contracts';
import {
  indexByOriginAndName,
  toolKey,
  type DiscoveredTool,
  type ExecuteOutcome,
  type OriginDiscovery,
  type ProviderTransport,
} from '@threshold/webmcp-adapter';

import {
  availabilityFirewall,
  holdFirewall,
  referralFirewall,
  releaseFirewall,
  type FirewallResult,
} from './firewall';
import { PROVIDERS, type ProviderEntry } from './registry';

/** How an origin is currently answering. Rendered on the provider panels and in `find_support`. */
export type ProviderConnection = {
  entry: ProviderEntry;
  state: 'connected' | 'timeout' | 'unavailable';
  /** Tool names the origin actually published to us. */
  tools: readonly string[];
  /** Expected tools it did not publish. A partially-implemented provider is worth seeing. */
  missingTools: readonly string[];
  ms: number;
  reason?: string;
};

export type BrokerEvents = {
  onConnectionsChanged?: (connections: readonly ProviderConnection[]) => void;
  /** Fired when a provider's tools disappear after the initial discovery. §45.3. */
  onProviderWithdrew?: (id: ProviderId) => void;
  onProviderReturned?: (id: ProviderId) => void;
};

/** Per-call budgets. Short, because a person is waiting and an organisation that is slow is a fact. */
export const BROKER_TIMEOUTS = {
  discoveryMs: 4000,
  queryMs: 2500,
  leaseMs: 2500,
  referralMs: 4000,
} as const;

/** The narrow slice of a `Validator` the broker needs, so tests can pass a stub. */
type OutboundValidator<I> = {
  tryParse: (value: unknown) => { ok: true; value: I } | { ok: false; error: { summary: string } };
};

export class ProviderBroker {
  private index = new Map<string, DiscoveredTool>();
  private connections: ProviderConnection[] = [];

  constructor(
    private readonly transport: ProviderTransport,
    private readonly events: BrokerEvents = {},
    private readonly providers: readonly ProviderEntry[] = PROVIDERS,
  ) {}

  get transportKind(): 'webmcp' | 'postmessage' {
    return this.transport.kind;
  }

  currentConnections(): readonly ProviderConnection[] {
    return this.connections;
  }

  connectionFor(id: ProviderId): ProviderConnection | undefined {
    return this.connections.find((c) => c.entry.id === id);
  }

  /**
   * Discover every registered origin.
   *
   * Called at startup and again on `toolchange`. Rebuilding the whole index rather than patching it
   * is deliberate: a provider that has withdrawn its tools must actually disappear from the index,
   * and a diff-based update is the kind of code that leaves a stale handle behind and then executes
   * against an origin that is no longer listening.
   */
  async refresh(options: { timeoutMs?: number } = {}): Promise<readonly ProviderConnection[]> {
    const origins = this.providers.map((p) => p.origin);
    const discoveries = await this.transport.discover(origins, {
      timeoutMs: options.timeoutMs ?? BROKER_TIMEOUTS.discoveryMs,
    });

    const previous = new Map(this.connections.map((c) => [c.entry.id, c.state]));
    this.index = indexByOriginAndName(discoveries);
    this.connections = this.providers.map((entry) =>
      toConnection(entry, discoveries.find((d) => d.origin === entry.origin)),
    );

    for (const connection of this.connections) {
      const before = previous.get(connection.entry.id);
      if (before === undefined) continue;
      if (before === 'connected' && connection.state !== 'connected') {
        this.events.onProviderWithdrew?.(connection.entry.id);
      } else if (before !== 'connected' && connection.state === 'connected') {
        this.events.onProviderReturned?.(connection.entry.id);
      }
    }

    this.events.onConnectionsChanged?.(this.connections);
    return this.connections;
  }

  private handle(entry: ProviderEntry, tool: string): DiscoveredTool | undefined {
    return this.index.get(toolKey(entry.origin, tool));
  }

  /**
   * Execute one provider tool through the whole pipeline.
   *
   * The outbound payload is validated against the provider's *input* contract before it leaves,
   * which is not ceremony. The hub composes that payload from its own state, and a hub bug that
   * sends a malformed query to three organisations at once should fail here, at the boundary, with
   * the field named, rather than as three separate `INVALID_INPUT` answers whose common cause is
   * invisible.
   */
  private async call<I, O>(
    entry: ProviderEntry,
    toolName: string,
    input: I,
    inputValidator: OutboundValidator<I>,
    firewall: (outcome: ExecuteOutcome) => FirewallResult<O>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<FirewallResult<O>> {
    const outbound = inputValidator.tryParse(input);
    if (!outbound.ok) {
      return {
        state: 'contract_error',
        summary: `hub composed an invalid request: ${outbound.error.summary}`,
        path: '',
        ms: 0,
      };
    }

    const tool = this.handle(entry, toolName);
    if (!tool) {
      return { state: 'unavailable', reason: `${entry.id} does not publish ${toolName}`, ms: 0 };
    }

    const outcome = await this.transport.execute(tool, outbound.value, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs,
    });
    return firewall(outcome);
  }

  queryAvailability(
    entry: ProviderEntry,
    query: ProviderQuery,
    options: { signal?: AbortSignal } = {},
  ): Promise<FirewallResult<ProviderAvailability>> {
    return this.call(entry, 'query_availability', query, V.providerQuery, availabilityFirewall, {
      ...options,
      timeoutMs: BROKER_TIMEOUTS.queryMs,
    });
  }

  hold(
    entry: ProviderEntry,
    input: ProviderHoldInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FirewallResult<ProviderHoldOutput>> {
    return this.call(entry, 'hold', input, V.providerHoldInput, holdFirewall, {
      ...options,
      timeoutMs: BROKER_TIMEOUTS.leaseMs,
    });
  }

  releaseHold(
    entry: ProviderEntry,
    input: ProviderReleaseInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FirewallResult<ProviderReleaseOutput>> {
    return this.call(entry, 'release_hold', input, V.providerReleaseInput, releaseFirewall, {
      ...options,
      timeoutMs: BROKER_TIMEOUTS.leaseMs,
    });
  }

  acceptReferral(
    entry: ProviderEntry,
    input: ProviderReferralInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FirewallResult<ProviderReferralOutput>> {
    return this.call(entry, 'accept_referral', input, V.providerReferralInput, referralFirewall, {
      ...options,
      timeoutMs: BROKER_TIMEOUTS.referralMs,
    });
  }

  /** Every discovered tool, grouped by origin. Rendered by `/verify`. */
  discoveredByOrigin(): Array<{ origin: string; tools: readonly string[] }> {
    const grouped = new Map<string, string[]>();
    for (const tool of this.index.values()) {
      const list = grouped.get(tool.origin) ?? [];
      list.push(tool.name);
      grouped.set(tool.origin, list);
    }
    return [...grouped.entries()]
      .map(([origin, tools]) => ({ origin, tools: tools.sort() }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }
}

function toConnection(
  entry: ProviderEntry,
  discovery: OriginDiscovery | undefined,
): ProviderConnection {
  if (!discovery) {
    return {
      entry,
      state: 'unavailable',
      tools: [],
      missingTools: entry.expectedTools,
      ms: 0,
      reason: 'origin was not queried',
    };
  }

  if (discovery.state !== 'ok') {
    return {
      entry,
      state: discovery.state,
      tools: [],
      missingTools: entry.expectedTools,
      ms: discovery.ms,
      ...(discovery.reason !== undefined ? { reason: discovery.reason } : {}),
    };
  }

  const names = discovery.tools.map((t) => t.name).sort();
  const missing = entry.expectedTools.filter((t) => !names.includes(t));
  return {
    entry,
    // An origin that answered with no tools at all has withdrawn them (§45). It is reachable and
    // not usable, which is a different thing from a timeout and is reported as such.
    state: names.length === 0 ? 'unavailable' : 'connected',
    tools: names,
    missingTools: missing,
    ms: discovery.ms,
    ...(names.length === 0 ? { reason: 'origin published no tools' } : {}),
  };
}
