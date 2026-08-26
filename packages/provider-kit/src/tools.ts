/**
 * The four provider tools. Build plan §10.
 *
 * Every provider exposes the same contract, so this file is written once and each provider app is
 * about forty lines of inventory plus a name. A provider need not implement all four: the public
 * directory implements `query_availability` only, because Threshold does not place holds against
 * real organisations (Invariant K).
 *
 * Two properties every handler here shares:
 *
 *  - **Input is validated even though it came from the hub.** The hub is not hostile, but it is not
 *    this code's business whether it is. A provider that trusts its caller because of who the caller
 *    claims to be has no boundary at all, and `exposedTo` restricts *who can call*, not *what they
 *    can say*.
 *  - **No free-form string is ever returned.** §46.1. Everything a handler emits is an enum, a
 *    boolean, an integer, or a pattern-constrained string, which is why the hub can mark its own
 *    output `untrustedContentHint: false` honestly.
 */

import {
  V,
  type ProviderAvailability,
  type ProviderHoldOutput,
  type ProviderId,
  type ProviderOffer,
  type ProviderReferralOutput,
  type ProviderReleaseOutput,
} from '@threshold/contracts';
import type { ProviderToolDefinition } from '@threshold/webmcp-adapter';

import { filterInventory } from './inventory';
import { isApiFailure, type LeaseApiClient } from './api-client';

export type ProviderConfig = {
  providerId: ProviderId;
  /** The organisation's own name, for its own page. Never sent to the hub. */
  displayName: string;
  inventory: readonly ProviderOffer[];
  api: LeaseApiClient;
  /** Which tools this provider offers. The directory offers query only. */
  capabilities: {
    query: boolean;
    lease: boolean;
    referral: boolean;
  };
  /** What the provider tells the person about retention, from trusted static config. */
  nextStep?: ProviderReferralOutput['next_step'];
  onActivity?: (line: string) => void;
};

/**
 * A provider error, as a shape the hub can act on.
 *
 * Deliberately *not* thrown. A rejected promise across `executeTool` gives the hub a string, and a
 * string is not something you can branch on. This is a contract for failure, which is the only kind
 * of failure a federation can actually handle.
 */
type ProviderError = { error: string; retryable: boolean };

function err(error: string, retryable = false): ProviderError {
  return { error, retryable };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------

export function buildProviderTools(config: ProviderConfig): ProviderToolDefinition[] {
  const tools: ProviderToolDefinition[] = [];
  const note = (line: string) => config.onActivity?.(line);

  if (config.capabilities.query) {
    tools.push({
      name: 'query_availability',
      title: 'Query availability',
      description:
        'Return structured availability matching typed requirements. Answers with capability fields ' +
        'and timing only: no descriptions, no notes, no contact details, no URLs.',
      inputSchema: V.providerQuery.raw.schema as object,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute(rawInput) {
        const parsed = V.providerQuery.tryParse(rawInput);
        if (!parsed.ok) {
          note(`query_availability rejected: ${parsed.error.summary}`);
          return err(`invalid query: ${parsed.error.summary}`);
        }

        const units = await config.api.units();
        const unitsLeft = (id: string) =>
          units[id] ?? config.inventory.find((o) => o.resource_id === id)?.units ?? 0;

        const offers = filterInventory(config.inventory, parsed.value, unitsLeft);
        note(`query_availability -> ${offers.length} offer(s)`);

        const result: ProviderAvailability = {
          provider_id: config.providerId,
          generated_at: nowIso(),
          offers,
        };

        // A provider validating its own output before sending it. Not paranoia: this is the check
        // that catches a seed-data edit which quietly breaks the contract, at the provider, where
        // the fix is, rather than at the hub as a mysterious rejection.
        const check = V.providerAvailability.tryParse(result);
        if (!check.ok) {
          note(`own output failed validation: ${check.error.summary}`);
          return err(`provider produced invalid output: ${check.error.summary}`);
        }
        return result;
      },
    });
  }

  if (config.capabilities.lease) {
    tools.push({
      name: 'hold',
      title: 'Hold a resource',
      description:
        'Place a short lease on one resource. The organisation is the authority on whether it holds: ' +
        'expiry is returned as an absolute time from the provider clock. Idempotent by client_request_id.',
      inputSchema: V.providerHoldInput.raw.schema as object,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(rawInput) {
        const parsed = V.providerHoldInput.tryParse(rawInput);
        if (!parsed.ok) return err(`invalid hold request: ${parsed.error.summary}`);

        const result = await config.api.hold(parsed.value);
        if (isApiFailure(result)) {
          note(`hold ${parsed.value.resource_id} -> api unreachable`);
          return err(`provider backend unreachable: ${result.reason}`, true);
        }

        note(`hold ${parsed.value.resource_id} -> ${result.outcome}`);

        switch (result.outcome) {
          case 'held':
          case 'reused': {
            const output: ProviderHoldOutput = {
              hold_id: result.lease.hold_id,
              resource_id: result.lease.resource_id,
              status: result.outcome === 'held' ? 'held' : 'reused',
              expires_at_epoch_ms: result.lease.expires_at_epoch_ms,
              ttl_seconds: Math.round(
                (result.lease.expires_at_epoch_ms - result.lease.created_at_epoch_ms) / 1000,
              ),
            };
            return output;
          }
          case 'conflict':
            // The conflict carries when the resource frees up and nothing about who holds it.
            return { error: 'HOLD_CONFLICT', retryable: true, held_until: result.heldUntilEpochMs };
          case 'not_holdable':
            return err('NOT_HOLDABLE');
          case 'no_such_resource':
            return err('HOLD_NOT_FOUND');
        }
      },
    });

    tools.push({
      name: 'release_hold',
      title: 'Release a hold',
      description:
        'Release a lease. Idempotent: releasing an already-released or lapsed lease is a normal ' +
        'outcome with its own status, not an error. Reports expired separately from released.',
      inputSchema: V.providerReleaseInput.raw.schema as object,
      annotations: { readOnlyHint: false, untrustedContentHint: false, idempotentHint: true },
      async execute(rawInput) {
        const parsed = V.providerReleaseInput.tryParse(rawInput);
        if (!parsed.ok) return err(`invalid release request: ${parsed.error.summary}`);

        const result = await config.api.release(parsed.value);
        if (isApiFailure(result)) {
          note(`release ${parsed.value.hold_id} -> api unreachable`);
          return err(`provider backend unreachable: ${result.reason}`, true);
        }

        note(`release ${parsed.value.hold_id} -> ${result.status}`);

        if (result.status === 'not_found') return err('HOLD_NOT_FOUND');
        const output: ProviderReleaseOutput = {
          hold_id: parsed.value.hold_id,
          status: result.status,
        };
        return output;
      },
    });
  }

  if (config.capabilities.referral) {
    tools.push({
      name: 'accept_referral',
      title: 'Accept a referral',
      description:
        'Receive identifying referral details against a live lease. The lease is re-checked server ' +
        'side: a lapsed, released or already-converted lease is refused and nothing is recorded. ' +
        'Idempotent by client_request_id.',
      inputSchema: V.providerReferralInput.raw.schema as object,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(rawInput) {
        const parsed = V.providerReferralInput.tryParse(rawInput);
        if (!parsed.ok) return err(`invalid referral: ${parsed.error.summary}`);

        const result = await config.api.referral(parsed.value);
        if (isApiFailure(result)) {
          // Ambiguous: the referral may or may not have landed. Retryable, and the idempotency key
          // is what makes retrying safe.
          note('accept_referral -> api unreachable');
          return err(`provider backend unreachable: ${result.reason}`, true);
        }

        // The log records that a referral arrived, and no field of it. §16.4.
        note(`accept_referral -> ${result.outcome}`);

        switch (result.outcome) {
          case 'accepted':
          case 'duplicate': {
            const output: ProviderReferralOutput = {
              referral_id: result.referral.referral_id,
              hold_id: result.referral.hold_id,
              status: result.outcome === 'accepted' ? 'accepted' : 'duplicate',
              received_at: new Date(result.referral.received_at_epoch_ms).toISOString(),
              ...(config.nextStep ? { next_step: config.nextStep } : {}),
            };
            return output;
          }
          case 'hold_expired':
            return err('HOLD_EXPIRED');
          case 'hold_released':
            return err('HOLD_NOT_FOUND');
          case 'hold_not_found':
            return err('HOLD_NOT_FOUND');
        }
      },
    });
  }

  return tools;
}
