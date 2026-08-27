/**
 * The hub, assembled.
 *
 * One object that owns the frames, the transport probe, the broker, the session, the state machine,
 * the orchestrator, the consent controller and the tool lifecycle — and one place where the wiring
 * between them is written down. The React layer subscribes to it and renders; it does not construct
 * anything and it does not decide anything.
 *
 * The order of startup matters and is not arbitrary:
 *
 *   1. mount the provider frames, because a provider's tools exist only while its document does;
 *   2. probe for a transport against a real origin, because "the methods exist" and "the methods
 *      work across an origin boundary in this browser" are different facts and only the second one
 *      decides whether this product works;
 *   3. discover, so the page can say which organisations answered before anyone asks it anything;
 *   4. register the hub's own tools for the current state, and re-register on every transition.
 *
 * Step 4 is where the tool surface becomes a state machine. `reconcile` is driven by transitions and
 * never from inside a handler, which `ToolLifecycle.guard` enforces at runtime rather than by
 * convention (§13.3).
 */

import type { HubToolName, ProviderId } from '@threshold/contracts';
import {
  ToolLifecycle,
  isWebMCPSupported,
  onToolChange,
  runtimeReport,
  selectTransport,
  type ProviderTransport,
  type RuntimeReport,
} from '@threshold/webmcp-adapter';

import { BoundaryLog } from '../audit/boundary-log';
import { ProviderBroker, type ProviderConnection } from '../broker/broker';
import { ProviderFrameHost } from '../broker/frames';
import { PROVIDER_ORIGINS } from '../broker/registry';
import { ConsentController } from '../consent/controller';
import { LeaseOrchestrator } from '../orchestration/orchestrator';
import { HubStateMachine, type HubState } from '../session/machine';
import { SessionStore } from '../session/session';
import { HubCore } from '../tools/core';
import { buildHubToolDefinitions } from '../tools/definitions';

export type HubAppView = {
  state: HubState;
  connections: readonly ProviderConnection[];
  registeredTools: readonly string[];
  transport: 'webmcp' | 'postmessage' | 'none';
  ready: boolean;
  runtime: RuntimeReport;
};

type ViewListener = (view: HubAppView) => void;

export class HubApp {
  readonly log = new BoundaryLog();
  readonly store = new SessionStore();
  readonly machine = new HubStateMachine();
  readonly consent = new ConsentController();

  private frames: ProviderFrameHost | null = null;
  private transport: ProviderTransport | null = null;
  private brokerRef: ProviderBroker | null = null;
  private coreRef: HubCore | null = null;
  private lifecycle: ToolLifecycle | null = null;
  private ready = false;
  private readonly listeners = new Set<ViewListener>();
  private connections: readonly ProviderConnection[] = [];

  get broker(): ProviderBroker {
    if (!this.brokerRef) throw new Error('HubApp.start() has not completed');
    return this.brokerRef;
  }

  get core(): HubCore {
    if (!this.coreRef) throw new Error('HubApp.start() has not completed');
    return this.coreRef;
  }

  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }

  view(): HubAppView {
    return {
      state: this.machine.current(),
      connections: this.connections,
      registeredTools: this.lifecycle?.registered() ?? [],
      transport: this.transport?.kind ?? 'none',
      ready: this.ready,
      runtime: runtimeReport(),
    };
  }

  private emit(): void {
    const view = this.view();
    for (const l of this.listeners) l(view);
  }

  async start(container: HTMLElement): Promise<void> {
    this.frames = new ProviderFrameHost({ container, origins: PROVIDER_ORIGINS });
    await this.frames.mount();

    // Probed against a real provider origin, never inferred from a user-agent string. `probeOrigin`
    // is the first registered provider because it is definitely loaded by the time we get here.
    this.transport = await selectTransport({
      probeOrigin: PROVIDER_ORIGINS[0]!,
      resolveWindow: this.frames.resolveWindow,
    });

    this.brokerRef = new ProviderBroker(this.transport, {
      onConnectionsChanged: (connections) => {
        this.connections = connections;
        this.emit();
      },
      onProviderWithdrew: (id: ProviderId) => this.log.providerWithdrew(id),
    });

    const orchestrator = new LeaseOrchestrator({
      broker: this.brokerRef,
      store: this.store,
      log: this.log,
      // The intermediate states are the demonstration, not bookkeeping: a countdown that starts on
      // a real lease and then stops is the fifteen seconds no single backend can fake (§43.5).
      onLeaseAcquired: (lease) => {
        this.machine.transition({
          tag: 'PARTIALLY_HELD',
          search_id: lease.search_id,
          ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
          hold_ids: this.store.allLeases().map((l) => l.hold_id),
        });
      },
      onCompensating: (planId) => {
        const record = this.store.plan(planId);
        this.machine.transition({
          tag: 'COMPENSATING',
          ...(record ? { search_id: record.search_id } : {}),
          plan_id: planId,
          hold_ids: this.store.allLeases().map((l) => l.hold_id),
          reason: 'LEASE_ORCHESTRATION_FAILED',
        });
      },
    });

    this.coreRef = new HubCore({
      broker: this.brokerRef,
      store: this.store,
      machine: this.machine,
      log: this.log,
      consent: this.consent,
      orchestrator,
    });

    this.log.transportSelected(
      this.transport.kind,
      this.transport.kind === 'webmcp'
        ? 'getTools({ fromOrigins }) answered'
        : 'cross-origin tool discovery was unavailable',
    );

    await this.brokerRef.refresh();

    if (isWebMCPSupported()) {
      this.lifecycle = new ToolLifecycle(
        buildHubToolDefinitions(this.coreRef, {
          guard: (fn) => this.lifecycle!.guard(fn),
        }),
      );

      // Every transition re-computes the visible tool set. This is the ordering claim made real:
      // `place_plan_holds` does not exist before a feasible plan does, so an agent cannot call it.
      this.machine.subscribe(() => void this.reconcileTools());
      await this.reconcileTools();

      // A provider withdrawing its tools fires this. The hub finds out because the tool set
      // changed, not because a request failed — which is the difference between showing federation
      // and showing error handling (§45.2).
      onToolChange(() => {
        void this.brokerRef?.refresh();
      });
    } else {
      this.log.toolSurfaceChanged([]);
    }

    this.ready = true;
    this.machine.subscribe(() => this.emit());
    this.consent.subscribe(() => this.emit());
    this.emit();
  }

  private async reconcileTools(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) return;
    const desired = this.machine.desiredTools();
    try {
      await lifecycle.reconcile(desired as HubToolName[]);
      this.log.toolSurfaceChanged(lifecycle.registered());
    } catch (e) {
      this.log.toolSurfaceChanged(lifecycle.registered());
      console.error('tool reconciliation failed', e);
    }
    this.emit();
  }

  /** Forget the session and put the tool surface back to READY. Build plan §29. */
  async reset(): Promise<void> {
    this.consent.abort();
    this.store.clear();
    this.log.clear();
    this.machine.transition({ tag: 'READY', hold_ids: [] });
    await this.brokerRef?.refresh();
  }

  destroy(): void {
    void this.lifecycle?.unregisterAll();
    this.frames?.destroy();
  }
}
