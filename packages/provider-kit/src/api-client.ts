/**
 * The provider page's client for its own same-origin API.
 *
 * The page is the provider's WebMCP face; the server is the authority on what it holds. This is the
 * short hop between them, and it is same-origin by construction: no CORS, no credentials to leak, no
 * second origin in the deployment.
 *
 * Every method returns a discriminated outcome rather than throwing. A provider tool that throws
 * across the federation boundary gives the hub an opaque failure, and the hub then cannot tell a
 * person whether the bed is taken or the organisation is simply not answering. Those are different
 * sentences.
 */

import type {
  ProviderHoldInput,
  ProviderReferralInput,
  ProviderReleaseInput,
} from '@threshold/contracts';
import type { AcquireResult, ConvertResult, ReleaseResult } from '@threshold/lease-store';

export type ApiFailure = { outcome: 'api_unreachable'; reason: string };

export type LeaseApiClient = {
  hold: (input: ProviderHoldInput) => Promise<AcquireResult | ApiFailure>;
  release: (input: ProviderReleaseInput) => Promise<ReleaseResult | ApiFailure>;
  referral: (input: ProviderReferralInput) => Promise<ConvertResult | ApiFailure>;
  units: () => Promise<Record<string, number>>;
};

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | ApiFailure> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Same-origin only. Stated rather than defaulted, so a future edit that points this at another
      // host has to think about it.
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    // A 409 is a real answer (conflict), not a transport failure, so the body is still parsed.
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => '');
      return { outcome: 'api_unreachable', reason: `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}` };
    }
    return (await res.json()) as T;
  } catch (e) {
    return { outcome: 'api_unreachable', reason: e instanceof Error ? e.message : String(e) };
  }
}

export function createLeaseApiClient(options: { prefix?: string } = {}): LeaseApiClient {
  const prefix = options.prefix ?? '/api';
  return {
    hold: (input) => postJson<AcquireResult>(`${prefix}/hold`, input),
    release: (input) => postJson<ReleaseResult>(`${prefix}/release`, input),
    referral: (input) => postJson<ConvertResult>(`${prefix}/referral`, input),
    units: async () => {
      try {
        const res = await fetch(`${prefix}/units`, { credentials: 'same-origin' });
        if (!res.ok) return {};
        return (await res.json()) as Record<string, number>;
      } catch {
        return {};
      }
    },
  };
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === 'api_unreachable'
  );
}
