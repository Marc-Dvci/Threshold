/**
 * The provider registry. Build plan §21.1, §23.3, §44.5.
 *
 * Static configuration, and that is the security control. Three things come from here and never from
 * a provider's own output:
 *
 *  1. **Which origins exist.** The hub calls a fixed list. It does not discover organisations, and a
 *     provider cannot introduce another one.
 *  2. **Which provider id an origin is.** A payload carries a `provider_id` and it validates, and the
 *     hub still uses the registry's. A provider claiming to be another provider should be impossible
 *     by construction rather than caught by a comparison.
 *  3. **Whether a claim is self-asserted or directory-attested.** Set here, so an organisation cannot
 *     promote its own claims. §23.10.
 */

import type { ProviderId, SupportKind } from '@threshold/contracts';
import type { AssertionClass } from '@threshold/contracts';

export type ProviderEntry = {
  id: ProviderId;
  origin: string;
  /** The organisation's name, as the hub is willing to show it. Not from the provider. */
  displayName: string;
  /** What it deals in. Drives the projection, so a provider is not asked irrelevant questions. */
  supportKinds: readonly SupportKind[];
  /** Which of the four tools it implements. The directory implements query only. */
  expectedTools: readonly string[];
  assertionClass: AssertionClass;
  /**
   * Retention statement shown in the consent panel.
   *
   * From trusted static configuration, never from provider tool output (§9.5). A retention promise
   * is a legal statement about a person's data, and letting the recipient of that data author the
   * promise at request time would be an obvious mistake.
   */
  retention: string;
  /** Contact route the plan document uses. Constructed here, never from provider output (§23.6). */
  contactPath?: string;
  /** True for anything sourced from a real public directory. Invariant K. */
  readOnly?: boolean;
};

/**
 * Origins come from the environment so one build serves local development and the deployment.
 *
 * Deliberately no default that points at a production host: a misconfigured build should fail
 * loudly against localhost rather than quietly reach a real deployment.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: 'respite-a',
    origin: env['VITE_ORIGIN_RESPITE'] ?? 'http://localhost:5101',
    displayName: 'Meadowbank Respite Unit',
    supportKinds: ['respite_bed'],
    expectedTools: ['query_availability', 'hold', 'release_hold', 'accept_referral'],
    assertionClass: 'self_asserted',
    retention:
      'Referral details are kept for 30 days if no placement is made, or for the duration of the ' +
      'placement plus 7 years if one is.',
    contactPath: '/contact',
  },
  {
    id: 'homecare-a',
    origin: env['VITE_ORIGIN_HOMECARE'] ?? 'http://localhost:5102',
    displayName: 'Selwyn Overnight Care',
    supportKinds: ['overnight_homecare'],
    expectedTools: ['query_availability', 'hold', 'release_hold', 'accept_referral'],
    assertionClass: 'self_asserted',
    retention: 'Referral details are kept for 90 days, then deleted if no care package starts.',
    contactPath: '/contact',
  },
  {
    id: 'transport-a',
    origin: env['VITE_ORIGIN_TRANSPORT'] ?? 'http://localhost:5103',
    displayName: 'Northgate Accessible Transport',
    supportKinds: ['accessible_transport'],
    expectedTools: ['query_availability', 'hold', 'release_hold', 'accept_referral'],
    assertionClass: 'self_asserted',
    retention: 'Journey details are kept for 12 months for insurance purposes.',
    contactPath: '/bookings',
  },
];

export const PROVIDER_ORIGINS: readonly string[] = PROVIDERS.map((p) => p.origin);

const byId = new Map<ProviderId, ProviderEntry>(PROVIDERS.map((p) => [p.id, p]));
const byOrigin = new Map<string, ProviderEntry>(PROVIDERS.map((p) => [p.origin, p]));

export function providerById(id: ProviderId): ProviderEntry | undefined {
  return byId.get(id);
}

export function providerByOrigin(origin: string): ProviderEntry | undefined {
  return byOrigin.get(origin);
}

/** Providers that could answer a question about these kinds of support. */
export function providersFor(kinds: readonly SupportKind[]): ProviderEntry[] {
  return PROVIDERS.filter((p) => p.supportKinds.some((k) => kinds.includes(k)));
}

/** Providers that can be leased against. Invariant K keeps directory entries out. */
export function leasableProviders(): ProviderEntry[] {
  return PROVIDERS.filter((p) => !p.readOnly);
}

/**
 * The display name for a provider id.
 *
 * Falls back to the id rather than to anything a provider said. A provider that is not in the
 * registry should not be able to put a string on the page, and the id is at least true.
 */
export function displayNameFor(id: ProviderId): string {
  return byId.get(id)?.displayName ?? id;
}
