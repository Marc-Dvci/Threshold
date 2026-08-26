/**
 * The provider's own HTTP API. Build plan §23.8, §29.
 *
 * Framework-free, so the same handler mounts in a Vite dev server as connect middleware and in a
 * plain Node server in production. One implementation means the lease semantics a test exercises are
 * the lease semantics that ship, rather than two code paths that agree until they do not.
 *
 * Rules from §23.8, all enforced here:
 *
 *  - **Same-origin only.** No CORS headers are emitted, deliberately. The provider *page* is the only
 *    thing that talks to this API, and it is same-origin with it. The hub reaches the provider
 *    through WebMCP or the `postMessage` bridge, never by calling this API across origins. Adding
 *    `Access-Control-Allow-Origin` here would quietly turn a federated design into a REST client.
 *  - **POST for every mutation**, so a link or a prefetch cannot take a bed.
 *  - **Idempotency keys** on the two mutating routes.
 *  - **No PII in a URL or a query string**, ever. The referral body is a POST body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { V } from '@threshold/contracts';
import type { LeaseStore, ResourceCapacity } from './store';

export type LeaseApiOptions = {
  /** Route prefix. Same-origin, so a short path is fine. */
  prefix?: string;
  /**
   * Guards the reset route. Build plan §29: a demo reset must exist and must not be a public button.
   * When unset, reset is refused rather than left open.
   */
  resetToken?: string;
  /** The inventory reset restores. */
  seedCapacity: readonly ResourceCapacity[];
  onEvent?: (event: { route: string; outcome: string }) => void;
};

const JSON_LIMIT_BYTES = 32_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // The provider API answers its own page and nothing else. Stating that in a header is cheap and
    // makes the intent legible to anyone auditing the deployment.
    'x-threshold-scope': 'same-origin-only',
  });
  res.end(text);
}

export function createLeaseApi(store: LeaseStore, options: LeaseApiOptions) {
  const prefix = options.prefix ?? '/api';
  const note = (route: string, outcome: string) => options.onEvent?.({ route, outcome });

  /** Returns true when the request was handled, so a host can fall through to static serving. */
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith(`${prefix}/`)) return false;

    const route = url.split('?')[0]!.slice(prefix.length + 1);
    const method = (req.method ?? 'GET').toUpperCase();

    // Reads
    if (route === 'state' && method === 'GET') {
      send(res, 200, store.snapshot());
      return true;
    }

    if (route === 'units' && method === 'GET') {
      const capacity = store.snapshot().capacity;
      send(
        res,
        200,
        Object.fromEntries(capacity.map((c) => [c.resource_id, store.unitsLeft(c.resource_id)])),
      );
      return true;
    }

    if (method !== 'POST') {
      send(res, 405, { error: 'mutations require POST' });
      return true;
    }

    let payload: unknown;
    try {
      const body = await readBody(req);
      payload = body.length > 0 ? JSON.parse(body) : {};
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : 'unreadable body' });
      return true;
    }

    switch (route) {
      case 'hold': {
        const parsed = V.providerHoldInput.tryParse(payload);
        if (!parsed.ok) {
          note('hold', 'invalid');
          send(res, 400, { error: parsed.error.summary });
          return true;
        }
        const result = store.acquire(parsed.value);
        note('hold', result.outcome);
        // 409 for a conflict, because it is one: another party holds the resource. An agent's
        // transport layer can then treat it as a real conflict rather than a generic failure.
        send(res, result.outcome === 'conflict' ? 409 : 200, result);
        return true;
      }

      case 'release': {
        const parsed = V.providerReleaseInput.tryParse(payload);
        if (!parsed.ok) {
          note('release', 'invalid');
          send(res, 400, { error: parsed.error.summary });
          return true;
        }
        const result = store.release(parsed.value.hold_id);
        note('release', result.status);
        // Release is idempotent, so every outcome is a 200. A 404 for "already released" would
        // invite a caller to retry something that already succeeded.
        send(res, 200, result);
        return true;
      }

      case 'referral': {
        const parsed = V.providerReferralInput.tryParse(payload);
        if (!parsed.ok) {
          note('referral', 'invalid');
          send(res, 400, { error: parsed.error.summary });
          return true;
        }
        const result = store.convert(parsed.value);
        note('referral', result.outcome);
        send(res, result.outcome === 'accepted' || result.outcome === 'duplicate' ? 200 : 409, result);
        return true;
      }

      case 'reset': {
        const token = (payload as { token?: unknown })?.token;
        if (!options.resetToken || token !== options.resetToken) {
          note('reset', 'refused');
          send(res, 403, { error: 'reset requires a matching token' });
          return true;
        }
        store.reset(options.seedCapacity);
        note('reset', 'ok');
        send(res, 200, { ok: true, capacity: options.seedCapacity });
        return true;
      }

      default:
        send(res, 404, { error: `no such route: ${route}` });
        return true;
    }
  };
}
