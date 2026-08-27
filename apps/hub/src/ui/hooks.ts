/**
 * Subscriptions from React to the hub.
 *
 * Plain `useState` + `useEffect` rather than `useSyncExternalStore`, deliberately. The hub's views
 * are freshly built objects, and `useSyncExternalStore` requires a snapshot that is referentially
 * stable between calls or it loops forever. Memoising every view to satisfy it would be work done
 * for the framework rather than for the product.
 *
 * The direction of dependency is the point: React reads the hub. The hub does not know React exists,
 * which is why the whole product is testable in Node.
 */

import { useEffect, useState } from 'react';

import type { HubApp, HubAppView } from '../app/hub-app';
import type { BoundaryEvent } from '../audit/boundary-log';
import type { ConsentView } from '../consent/controller';

export function useHubView(hub: HubApp): HubAppView {
  const [view, setView] = useState<HubAppView>(() => hub.view());
  useEffect(() => hub.subscribe(setView), [hub]);
  return view;
}

export function useConsent(hub: HubApp): ConsentView | null {
  const [view, setView] = useState<ConsentView | null>(() => hub.consent.view());
  useEffect(() => hub.consent.subscribe(setView), [hub]);
  return view;
}

export function useBoundaryLog(hub: HubApp): readonly BoundaryEvent[] {
  const [events, setEvents] = useState<readonly BoundaryEvent[]>(() => hub.log.all());
  useEffect(() => hub.log.subscribe((next) => setEvents([...next])), [hub]);
  return events;
}

/**
 * A ticking clock for lease countdowns.
 *
 * One interval for the whole page rather than one per lease. The value it produces is only ever used
 * to *render* a number computed from the provider's absolute expiry; it is never the authority on
 * whether a lease is alive (Invariant E).
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** `mm:ss`, or `expired`. Announced politely, not urgently: a ticking assertive region is torture. */
export function formatCountdown(expiresAtEpochMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((expiresAtEpochMs - nowMs) / 1000));
  if (seconds === 0) return 'expired';
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
