/**
 * Opaque identifier minting.
 *
 * Every id in the system matches `^[a-z]{1,10}_[A-Za-z0-9]{6,24}$`, which is not decoration: an
 * unconstrained id would be a free-form string surface in the provider result contract, which is
 * exactly what §46.1 forbids. Constraining the *shape* of an id is what lets `hold_id` and
 * `resource_id` cross the trust boundary at all.
 *
 * The generator is swappable so the recording rig and the test suite can run deterministically. A
 * film whose identifiers differ between takes is a film that cannot be re-cut, and a test that
 * asserts on a random id is a test nobody trusts.
 */

export type IdPrefix = 'search' | 'plan' | 'hold' | 'ref' | 'consent' | 'lease' | 'req' | 'ev';

export type IdSource = () => string;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random by default. Ten characters is ample for a browser session. */
const randomSource: IdSource = () => {
  const bytes = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
};

let source: IdSource = randomSource;

/**
 * A deterministic source: `aaaaaaaaab`, `aaaaaaaaac`, ... seeded so two runs match.
 *
 * Sequential rather than a seeded PRNG on purpose. A PRNG would be more realistic-looking and
 * strictly worse for a demo: when a log line reads `hold_aaaaaaaaad` you can count which hold it is,
 * which turns reviewing a take from guesswork into reading.
 */
export function deterministicIdSource(start = 0): IdSource {
  let n = start;
  return () => {
    n += 1;
    let out = '';
    let v = n;
    for (let i = 0; i < 10; i += 1) {
      out = ALPHABET[v % 36]! + out;
      v = Math.floor(v / 36);
    }
    return out;
  };
}

export function setIdSource(next: IdSource): void {
  source = next;
}

export function resetIdSource(): void {
  source = randomSource;
}

export function mintId(prefix: IdPrefix): string {
  return `${prefix}_${source()}`;
}

const ID_RE = /^[a-z]{1,10}_[A-Za-z0-9]{6,24}$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * A stable idempotency key for one plan's lease on one role.
 *
 * Derived rather than random, and that is the whole point: a retry after an ambiguous network result
 * must produce the *same* key, or the retry acquires a second lease on a scarce resource and the
 * system has just taken a bed away from someone for no reason.
 *
 * FNV-1a because it is short, dependency-free and needs no cryptographic property: this key is
 * never a secret, only a stable name for "this plan's transport leg".
 */
export function leaseRequestId(planId: string, role: string): string {
  let hash = 0x811c9dc5;
  const input = `${planId}:${role}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = '';
  let v = hash;
  for (let i = 0; i < 8; i += 1) {
    out = ALPHABET[v % 36]! + out;
    v = Math.floor(v / 36);
  }
  return `req_${out}`;
}
