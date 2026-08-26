/**
 * Runtime validation. Build plan §5.3, §11.
 *
 * Three rules, none of them optional:
 *
 *  1. Validators are compiled once, at module load, not per call. A compile inside a tool handler is
 *     a latency spike on the exact path a judge is watching.
 *  2. A WebMCP `inputSchema` is a *hint to the agent*, never a guarantee about what arrives. The
 *     browser may or may not enforce it, the agent may or may not respect it, and neither is this
 *     code's business. Everything crossing a boundary is validated here.
 *  3. A validation failure is never partially accepted. There is no "use the fields that parsed".
 *
 * `ContractError` carries the JSON Pointer path and the offending keyword, and deliberately does
 * *not* carry the offending value. A rejected provider payload is exactly the payload most likely
 * to be attacker-authored, and an error object is a channel like any other: §11.3.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JSONSchema } from 'json-schema-to-ts';

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  // A top-level `oneOf` without a sibling `type` is a legitimate shape here (explain_gap accepts
  // two request forms). Everything else stays strict.
  strictTypes: false,
  // Provider payloads are small and fully specified. Coercion would defeat the point of the
  // boundary: a string "true" arriving where a boolean belongs is a contract violation, not an
  // inconvenience to be smoothed over.
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

addFormats(ajv, ['date-time', 'date', 'email']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ContractViolation = {
  /** JSON Pointer into the rejected document. Safe to log and to show. */
  path: string;
  /** The schema keyword that rejected it: `additionalProperties`, `pattern`, `enum`, ... */
  keyword: string;
  /** For `additionalProperties`, the offending property *name*. Never its value. */
  property?: string;
};

export class ContractError extends Error {
  readonly violations: readonly ContractViolation[];
  readonly contract: string;

  constructor(contract: string, violations: readonly ContractViolation[]) {
    const first = violations[0];
    super(
      first
        ? `${contract}: ${first.keyword} at ${first.path || '/'}${first.property ? ` (${first.property})` : ''}`
        : `${contract}: rejected`,
    );
    this.name = 'ContractError';
    this.contract = contract;
    this.violations = violations;
  }

  /** One line, safe for the boundary log and the security panel. */
  get summary(): string {
    const v = this.violations[0];
    if (!v) return `${this.contract}: rejected`;
    if (v.keyword === 'additionalProperties' && v.property) {
      return `unexpected field \`${v.property}\``;
    }
    return `${v.keyword} failed at ${v.path || '/'}`;
  }
}

/**
 * Reduce Ajv's error list to safe metadata.
 *
 * Ajv puts the offending value in `error.data` for some keywords and interpolates values into
 * `error.message` for others. Neither is carried forward. This function is the reason a malicious
 * provider string cannot reach a log file by way of an exception.
 */
function toViolations(errors: readonly ErrorObject[] | null | undefined): ContractViolation[] {
  if (!errors || errors.length === 0) return [{ path: '', keyword: 'unknown' }];
  return errors.slice(0, 8).map((e) => {
    const violation: ContractViolation = {
      path: e.instancePath,
      keyword: e.keyword,
    };
    if (e.keyword === 'additionalProperties') {
      const extra = (e.params as { additionalProperty?: unknown }).additionalProperty;
      if (typeof extra === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(extra)) {
        violation.property = extra;
      } else {
        // A property name that is not a plain identifier is itself suspicious. Say so, do not
        // repeat it.
        violation.property = '<non-identifier>';
      }
    }
    return violation;
  });
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export type Validator<T> = {
  /** Narrowing check. Does not throw. */
  check: (value: unknown) => value is T;
  /** Validate and return, or throw a `ContractError` carrying safe metadata only. */
  parse: (value: unknown) => T;
  /** Validate and return violations rather than throwing. */
  tryParse: (value: unknown) => { ok: true; value: T } | { ok: false; error: ContractError };
  /** The compiled Ajv function, for tests that want to inspect raw errors. */
  raw: ValidateFunction;
  readonly contract: string;
};

const compiled = new Map<string, Validator<unknown>>();

/**
 * Compile a validator for a schema, memoised by contract name.
 *
 * `T` is passed explicitly at the call site rather than inferred from the schema, and that is a
 * deliberate retreat from a cleverer signature. `Validator<FromSchema<S>>` type-checks, but
 * resolving `FromSchema` *inside* a generic makes TypeScript instantiate the conditional-type
 * machinery once per constraint rather than once per concrete schema, and on this schema set it
 * blows the instantiation depth limit outright (TS2589/TS2590).
 *
 * Nothing is lost: `contracts.ts` passes the type derived from the same schema by `types.ts`, so
 * there is still exactly one source of truth. The pairing is checked structurally by
 * `tests/unit/contract-types.test.ts`, which fails if a validator's declared type and its schema
 * ever describe different shapes.
 */
export function validator<T>(contract: string, schema: JSONSchema): Validator<T> {
  const existing = compiled.get(contract);
  if (existing) return existing as Validator<T>;

  const fn = ajv.compile(schema as object);

  const v: Validator<T> = {
    contract,
    raw: fn,
    check(value: unknown): value is T {
      return fn(value) as boolean;
    },
    parse(value: unknown): T {
      if (fn(value)) return value as T;
      throw new ContractError(contract, toViolations(fn.errors));
    },
    tryParse(value: unknown) {
      if (fn(value)) return { ok: true as const, value: value as T };
      return { ok: false as const, error: new ContractError(contract, toViolations(fn.errors)) };
    },
  };

  compiled.set(contract, v as Validator<unknown>);
  return v;
}

/** Every contract compiled so far. Used by the diagnostics panel and by the security tests. */
export function compiledContracts(): readonly string[] {
  return [...compiled.keys()].sort();
}

/**
 * Parse a provider result string.
 *
 * The federation leg is declared `Promise<DOMString>`, so what arrives is a string or `null`. A
 * `null` means the call triggered a navigation, which is a contract violation and emphatically not
 * an empty success: reading it as one is silent data loss, and it was the shape of the bug revision
 * 1.0's wrapper would have had.
 */
export function parseProviderPayload<T>(raw: string | null, v: Validator<T>): T {
  if (raw === null) {
    throw new ContractError(v.contract, [{ path: '', keyword: 'navigation' }]);
  }
  if (typeof raw !== 'string') {
    throw new ContractError(v.contract, [{ path: '', keyword: 'not-a-string' }]);
  }
  if (raw.length > 64_000) {
    throw new ContractError(v.contract, [{ path: '', keyword: 'oversized' }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractError(v.contract, [{ path: '', keyword: 'malformed-json' }]);
  }
  return v.parse(parsed);
}
