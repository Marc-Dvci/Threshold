/**
 * The structural guard behind the security claim.
 *
 * Build plan §46.1 claims that every field a provider returns is an enum, a boolean, a number, or a
 * string under a pattern or a format, so there is no free-form surface in the provider result
 * contract for an instruction to occupy.
 *
 * That claim is only worth making if it stays true. A rule enforced by review is a rule that lapses
 * the first time somebody adds `{ type: 'string' }` to a provider output schema at midnight. So
 * this test walks every provider output schema and *proves* the property, rather than checking the
 * four cases somebody happened to think of.
 *
 * This is the difference between a demonstration and a guarantee: the demo in §46.1 shows an attack
 * failing, which proves one attack fails. This proves no such field exists to attack.
 */

import { describe, expect, it } from 'vitest';

import { PROVIDER_OUTPUT_SCHEMAS } from '@threshold/contracts';

type Schema = Record<string, unknown>;

/** A string schema is constrained if any of these narrow what it can contain. */
const STRING_CONSTRAINTS = ['enum', 'const', 'pattern', 'format'] as const;

type Finding = { path: string; reason: string };

/**
 * Walk a JSON Schema and collect every string-typed leaf that is not constrained, plus every object
 * that omits `additionalProperties: false`.
 *
 * `maxLength` alone deliberately does NOT count as a constraint. "Ignore all prior instructions" is
 * 30 characters. A length bound limits blast radius; it does not remove the surface.
 */
function findUnconstrainedSurfaces(schema: Schema, path = ''): Finding[] {
  const findings: Finding[] = [];

  for (const branch of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = schema[branch];
    if (Array.isArray(list)) {
      list.forEach((sub, i) => {
        findings.push(...findUnconstrainedSurfaces(sub as Schema, `${path}/${branch}/${i}`));
      });
    }
  }

  const type = schema['type'];

  if (type === 'string') {
    const constrained = STRING_CONSTRAINTS.some((k) => schema[k] !== undefined);
    if (!constrained) {
      findings.push({
        path: path || '/',
        reason: 'string with no enum, const, pattern or format',
      });
    }
    return findings;
  }

  if (type === 'object' || schema['properties'] !== undefined) {
    if (schema['additionalProperties'] !== false) {
      findings.push({
        path: path || '/',
        reason: 'object without additionalProperties: false',
      });
    }
    const props = schema['properties'];
    if (props && typeof props === 'object') {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        findings.push(...findUnconstrainedSurfaces(sub as Schema, `${path}/${key}`));
      }
    }
    // A `propertyNames`-free map type would be a surface too; none exists, and this catches it if
    // one is ever added.
    if (schema['patternProperties'] !== undefined) {
      findings.push({ path: path || '/', reason: 'patternProperties is a free-form key surface' });
    }
    return findings;
  }

  if (type === 'array' || schema['items'] !== undefined) {
    const items = schema['items'];
    if (items && typeof items === 'object') {
      findings.push(...findUnconstrainedSurfaces(items as Schema, `${path}/items`));
    }
    if (schema['maxItems'] === undefined) {
      findings.push({ path: path || '/', reason: 'array without maxItems' });
    }
    return findings;
  }

  return findings;
}

describe('provider output contracts have no free-form surface', () => {
  const names = Object.keys(PROVIDER_OUTPUT_SCHEMAS);

  it('covers every provider output contract', () => {
    // If a fifth provider output schema is added and not registered here, this is the tripwire.
    expect(names).toEqual([
      'provider.query_availability.output',
      'provider.hold.output',
      'provider.release_hold.output',
      'provider.accept_referral.output',
      // The failure path is covered too. An `{ error: string }` envelope would have been a sentence
      // authored by the provider, arriving on the path least likely to be looked at.
      'provider.error',
    ]);
  });

  for (const [name, schema] of Object.entries(PROVIDER_OUTPUT_SCHEMAS)) {
    it(`${name} exposes no unconstrained field`, () => {
      const findings = findUnconstrainedSurfaces(schema as unknown as Schema);
      // Report the whole list, not just the first: a contributor who added three should see three.
      expect(findings, `unconstrained surfaces in ${name}:\n${JSON.stringify(findings, null, 2)}`)
        .toEqual([]);
    });
  }
});

describe('the guard itself fails when it should', () => {
  // Build plan §34: "make every guard fail once on purpose". A structural test that has never been
  // seen to fail is a test whose passing means nothing.

  it('catches a plain string field', () => {
    const bad: Schema = {
      type: 'object',
      additionalProperties: false,
      properties: { note: { type: 'string' } },
    };
    expect(findUnconstrainedSurfaces(bad)).toEqual([
      { path: '/note', reason: 'string with no enum, const, pattern or format' },
    ]);
  });

  it('does not accept maxLength as a constraint', () => {
    const bad: Schema = {
      type: 'object',
      additionalProperties: false,
      properties: { note: { type: 'string', maxLength: 200 } },
    };
    expect(findUnconstrainedSurfaces(bad)).toHaveLength(1);
  });

  it('catches an open object', () => {
    const bad: Schema = { type: 'object', properties: {} };
    expect(findUnconstrainedSurfaces(bad)).toEqual([
      { path: '/', reason: 'object without additionalProperties: false' },
    ]);
  });

  it('catches an unbounded array', () => {
    const bad: Schema = { type: 'array', items: { type: 'boolean' } };
    expect(findUnconstrainedSurfaces(bad)).toEqual([
      { path: '/', reason: 'array without maxItems' },
    ]);
  });

  it('catches a string nested inside a oneOf branch', () => {
    const bad: Schema = {
      type: 'object',
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { a: { type: 'boolean' } } },
        { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } },
      ],
    };
    const findings = findUnconstrainedSurfaces(bad);
    expect(findings).toContainEqual({
      path: '/oneOf/1/b',
      reason: 'string with no enum, const, pattern or format',
    });
  });

  it('catches patternProperties', () => {
    const bad: Schema = {
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'boolean' } },
      properties: {},
    };
    expect(findUnconstrainedSurfaces(bad)).toContainEqual({
      path: '/',
      reason: 'patternProperties is a free-form key surface',
    });
  });

  it('accepts each of the four legitimate constraint keywords', () => {
    for (const keyword of STRING_CONSTRAINTS) {
      const okSchema: Schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', [keyword]: keyword === 'enum' ? ['a'] : 'a' },
        },
      };
      expect(findUnconstrainedSurfaces(okSchema)).toEqual([]);
    }
  });
});
