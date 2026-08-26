/**
 * The data-boundary log. Build plan §16.4, §23.7.
 *
 * A visible record of what crossed which boundary, in a page whose entire claim is about boundaries.
 * It is a demo asset and a debugging tool, and it is also the thing that makes the privacy design
 * checkable instead of stated: a person can watch four typed fields go to three organisations and
 * nothing identifying go anywhere until they press Send.
 *
 * **The one rule: field names, never values.** A log that printed what it logged about would itself
 * be the disclosure the rest of the system is arranged to prevent. `logReferral` takes a list of
 * field *names* and has no parameter that could carry a value, which is a stronger guarantee than
 * remembering not to pass one.
 */

import type { ProviderId, ReferralFieldName } from '@threshold/contracts';

export type BoundaryDirection =
  | 'agent_to_hub'
  | 'hub_to_provider'
  | 'provider_to_hub'
  | 'hub_internal'
  | 'human';

export type BoundaryEvent = {
  seq: number;
  at: string;
  direction: BoundaryDirection;
  /** Who, in registry terms. Never a free string from a provider. */
  provider?: ProviderId;
  /** What happened, from a closed set of phrasings this module owns. */
  summary: string;
  /** Field names only. */
  fields?: readonly string[];
  severity: 'info' | 'notice' | 'warn';
};

type Listener = (events: readonly BoundaryEvent[]) => void;

const MAX_EVENTS = 200;

export class BoundaryLog {
  private events: BoundaryEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  /** Injectable so the recording rig gets stable timestamps. */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.events);
    return () => this.listeners.delete(listener);
  }

  all(): readonly BoundaryEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.events;
    for (const l of this.listeners) l(snapshot);
  }

  private push(event: Omit<BoundaryEvent, 'seq' | 'at'>): void {
    this.seq += 1;
    const at = this.clock().toLocaleTimeString('en-GB', { hour12: false });
    this.events = [{ ...event, seq: this.seq, at }, ...this.events].slice(0, MAX_EVENTS);
    this.emit();
  }

  // -------------------------------------------------------------------------
  // The typed entry points. There is no generic `log(string)` on purpose: every line on this panel
  // is one of a known set, so nothing can put arbitrary text on it.
  // -------------------------------------------------------------------------

  agentCalled(tool: string, fieldCount: number): void {
    this.push({
      direction: 'agent_to_hub',
      summary: `${tool} (${fieldCount} typed field${fieldCount === 1 ? '' : 's'})`,
      severity: 'info',
    });
  }

  queriedProvider(provider: ProviderId, fields: readonly string[]): void {
    this.push({
      direction: 'hub_to_provider',
      provider,
      summary: 'query_availability',
      fields,
      severity: 'info',
    });
  }

  providerAnswered(provider: ProviderId, offerCount: number, ms: number): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: `${offerCount} validated offer${offerCount === 1 ? '' : 's'} in ${ms}ms`,
      severity: 'info',
    });
  }

  providerUnavailable(provider: ProviderId, state: 'timeout' | 'unavailable'): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: state === 'timeout' ? 'did not answer in time' : 'not reachable',
      severity: 'warn',
    });
  }

  /**
   * A provider payload failed strict validation.
   *
   * Carries the rule and the field *name* only. The rejected payload is the payload most likely to
   * be attacker-authored, and an audit line is a channel like any other. §11.3.
   */
  contractViolation(provider: ProviderId, ruleSummary: string): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: `response rejected: ${ruleSummary}`,
      severity: 'warn',
    });
  }

  identityMismatch(provider: ProviderId): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: 'declared a different provider id than its origin; registry value used',
      severity: 'warn',
    });
  }

  planChecked(planId: string, feasible: boolean, failing: number): void {
    this.push({
      direction: 'hub_internal',
      summary: feasible
        ? `plan ${planId} checked: all links hold`
        : `plan ${planId} checked: ${failing} link${failing === 1 ? '' : 's'} fail`,
      severity: feasible ? 'info' : 'notice',
    });
  }

  leaseAcquired(provider: ProviderId, resource: string, holdId: string, seconds: number): void {
    this.push({
      direction: 'hub_to_provider',
      provider,
      summary: `lease ${resource} -> ${holdId}, ${seconds}s`,
      severity: 'notice',
    });
  }

  leaseRefused(provider: ProviderId, resource: string, reason: string): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: `lease ${resource} refused: ${reason}`,
      severity: 'warn',
    });
  }

  compensationStarted(planId: string, leaseCount: number): void {
    this.push({
      direction: 'hub_internal',
      summary: `plan ${planId} failed: unwinding ${leaseCount} lease${leaseCount === 1 ? '' : 's'}`,
      severity: 'notice',
    });
  }

  leaseReleased(provider: ProviderId, holdId: string, status: string): void {
    this.push({
      direction: 'hub_to_provider',
      provider,
      summary: `release ${holdId} -> ${status}`,
      severity: status === 'unreachable' ? 'warn' : 'info',
    });
  }

  compensationFinished(planId: string, complete: boolean): void {
    this.push({
      direction: 'hub_internal',
      summary: complete
        ? `plan ${planId}: nothing is held`
        : `plan ${planId}: one lease could not be released and will lapse on its own`,
      severity: complete ? 'info' : 'warn',
    });
  }

  consentPending(provider: ProviderId, fields: readonly ReferralFieldName[]): void {
    this.push({
      direction: 'human',
      provider,
      summary: 'waiting for the person to review and send',
      fields,
      severity: 'notice',
    });
  }

  consentSettled(outcome: 'sent' | 'cancelled' | 'aborted' | 'expired'): void {
    const summary =
      outcome === 'sent'
        ? 'the person pressed Send'
        : outcome === 'cancelled'
          ? 'the person cancelled; nothing was sent'
          : outcome === 'aborted'
            ? 'the agent cancelled; nothing was sent'
            : 'the lease lapsed while the panel was open; nothing was sent';
    this.push({ direction: 'human', summary, severity: outcome === 'sent' ? 'notice' : 'info' });
  }

  /**
   * The one line that records identifying data crossing an origin.
   *
   * Takes names, and has nowhere to put a value.
   */
  referralSent(provider: ProviderId, fields: readonly ReferralFieldName[]): void {
    this.push({
      direction: 'hub_to_provider',
      provider,
      summary: 'identifying referral transmitted',
      fields,
      severity: 'notice',
    });
  }

  referralAccepted(provider: ProviderId, referralId: string): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: `referral ${referralId} accepted`,
      severity: 'notice',
    });
  }

  transportSelected(kind: 'webmcp' | 'postmessage', detail: string): void {
    this.push({
      direction: 'hub_internal',
      summary:
        kind === 'webmcp'
          ? `WebMCP federation in use (${detail})`
          : `same-origin bridge in use, not WebMCP federation (${detail})`,
      severity: kind === 'webmcp' ? 'info' : 'warn',
    });
  }

  toolSurfaceChanged(registered: readonly string[]): void {
    this.push({
      direction: 'hub_internal',
      summary: `tools available to the agent: ${registered.join(', ') || 'none'}`,
      severity: 'info',
    });
  }

  providerWithdrew(provider: ProviderId): void {
    this.push({
      direction: 'provider_to_hub',
      provider,
      summary: 'withdrew its tools; the tool set changed',
      severity: 'warn',
    });
  }
}
