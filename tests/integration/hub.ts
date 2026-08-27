/**
 * A hub, assembled for tests, over the in-process federation.
 *
 * Everything the browser build wires together in `HubApp`, minus the browser: the same broker, the
 * same store, the same state machine, the same orchestrator, the same consent controller, the same
 * nine handlers. The intermediate state transitions are wired the same way too, so a test can assert
 * that the page really did pass through PARTIALLY_HELD and COMPENSATING rather than jumping from
 * one steady state to another.
 */

import { BoundaryLog } from '../../apps/hub/src/audit/boundary-log';
import { ProviderBroker } from '../../apps/hub/src/broker/broker';
import { ConsentController } from '../../apps/hub/src/consent/controller';
import { LeaseOrchestrator } from '../../apps/hub/src/orchestration/orchestrator';
import { HubStateMachine, type HubStateTag } from '../../apps/hub/src/session/machine';
import { SessionStore } from '../../apps/hub/src/session/session';
import { HubCore } from '../../apps/hub/src/tools/core';

import { createFederation, type Federation } from './federation';

export type TestHub = {
  core: HubCore;
  store: SessionStore;
  machine: HubStateMachine;
  broker: ProviderBroker;
  orchestrator: LeaseOrchestrator;
  consent: ConsentController;
  log: BoundaryLog;
  federation: Federation;
  /** Every state tag the machine has passed through, in order. */
  trace: HubStateTag[];
  connect: () => Promise<void>;
};

export async function createTestHub(
  options: {
    ttlSeconds?: number;
    now?: () => number;
    /**
     * Share a federation with another hub.
     *
     * This is how the collision test is real rather than staged: two independent hub sessions, each
     * with its own store, state machine and consent controller, contending for one unit of R17 in
     * one `LeaseStore` — exactly as two browser tabs contend for one bed at one organisation.
     */
    federation?: Federation;
  } = {},
): Promise<TestHub> {
  const federation =
    options.federation ??
    createFederation({
      ...(options.ttlSeconds !== undefined ? { maxTtlSeconds: options.ttlSeconds } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

  const log = new BoundaryLog();
  const store = new SessionStore();
  const machine = new HubStateMachine();
  const consent = new ConsentController(options.now ? { now: options.now } : {});
  const broker = new ProviderBroker(federation.transport);

  const trace: HubStateTag[] = [machine.tag()];
  machine.subscribe((state) => {
    if (trace[trace.length - 1] !== state.tag) trace.push(state.tag);
  });

  const orchestrator = new LeaseOrchestrator({
    broker,
    store,
    log,
    ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
    onLeaseAcquired: (lease) => {
      machine.transition({
        tag: 'PARTIALLY_HELD',
        search_id: lease.search_id,
        ...(lease.plan_id ? { plan_id: lease.plan_id } : {}),
        hold_ids: store.allLeases().map((l) => l.hold_id),
      });
    },
    onCompensating: (planId) => {
      machine.transition({
        tag: 'COMPENSATING',
        plan_id: planId,
        hold_ids: store.allLeases().map((l) => l.hold_id),
        reason: 'LEASE_ORCHESTRATION_FAILED',
      });
    },
  });

  const core = new HubCore({
    broker,
    store,
    machine,
    log,
    consent,
    orchestrator,
    ...(options.now ? { now: options.now } : {}),
  });

  const hub: TestHub = {
    core,
    orchestrator,
    store,
    machine,
    broker,
    consent,
    log,
    federation,
    trace,
    connect: async () => {
      await broker.refresh();
    },
  };

  await hub.connect();
  return hub;
}

/** Narrow a `ToolResult` to its success, failing loudly with the error code if it is not one. */
export function expectOk<T>(result: { ok: boolean; data?: unknown; error?: { code: string; message: string } }): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error?.code}: ${result.error?.message}`);
  }
  return result.data as T;
}

/** Narrow a `ToolResult` to its failure. */
export function expectFail(result: {
  ok: boolean;
  error?: { code: string; message: string };
  data?: unknown;
}): { code: string; message: string; data?: unknown } {
  if (result.ok) throw new Error('expected a failure, got success');
  return { ...result.error!, ...(result.data !== undefined ? { data: result.data } : {}) };
}
