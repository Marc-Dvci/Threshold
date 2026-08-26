/**
 * Schema fragments shared across the agent-facing and provider-facing contracts.
 *
 * Every schema in this package is written once, as JSON Schema, `as const`. TypeScript types are
 * *derived* from it with `FromSchema`, and Ajv validates against the same object. There is no
 * second hand-written copy of any contract, because the same contract written twice in two
 * languages is two chances to drift and a permanent tax on every change.
 *
 * Build plan §5.3, §7.3, §46.1.
 */

import {
  ASSERTION_CLASSES,
  CLOCK_TIME_PATTERN,
  DAY_OFFSETS,
  PROVIDER_IDS,
  PROVIDER_STATES,
  SERVICE_AREAS,
  SPOKEN_LANGUAGES,
  SUPPORT_KINDS,
} from '../vocabulary';

/**
 * A resource identifier.
 *
 * Pattern-constrained, and this is a security control (§46.1). A free-string `resource_id` is a
 * free-form surface inside the provider result contract, which is precisely what must not exist. An
 * instruction to a model does not fit in `^[A-Z]{1,3}[0-9]{1,4}$`.
 */
export const resourceIdSchema = {
  type: 'string',
  pattern: '^[A-Z]{1,3}[0-9]{1,4}$',
  minLength: 2,
  maxLength: 8,
} as const;

/** Wall-clock time. Pattern-constrained for the same reason as resource ids. */
export const clockTimeSchema = {
  type: 'string',
  pattern: CLOCK_TIME_PATTERN,
  minLength: 5,
  maxLength: 5,
} as const;

/** A day offset plus a wall clock. See `time.ts` for why there is no timezone. */
export const instantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['day', 'at'],
  properties: {
    day: { type: 'integer', enum: DAY_OFFSETS },
    at: clockTimeSchema,
  },
} as const;

/** A closed interval between two instants. */
export const intervalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: instantSchema,
    to: instantSchema,
  },
} as const;

export const providerIdSchema = {
  type: 'string',
  enum: PROVIDER_IDS,
} as const;

export const serviceAreaSchema = {
  type: 'string',
  enum: SERVICE_AREAS,
} as const;

export const supportKindSchema = {
  type: 'string',
  enum: SUPPORT_KINDS,
} as const;

export const spokenLanguageSchema = {
  type: 'string',
  enum: SPOKEN_LANGUAGES,
} as const;

/**
 * Languages a service can speak. An array of enums with a hard `maxItems`, never `string[]`.
 * `string[]` was the fourth free-form surface in revision 1.0's provider contract; the other three
 * were `provider_id`, `resource_id` and `generated_at`.
 */
export const spokenLanguagesSchema = {
  type: 'array',
  items: spokenLanguageSchema,
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
} as const;

export const assertionClassSchema = {
  type: 'string',
  enum: ASSERTION_CLASSES,
} as const;

/**
 * `generated_at` was the third free-form surface. Constrained to a date-time and additionally
 * range-checked at runtime, because `format` is an annotation Ajv only enforces when
 * `ajv-formats` is attached and validation is strict.
 */
export const generatedAtSchema = {
  type: 'string',
  format: 'date-time',
  minLength: 20,
  maxLength: 30,
} as const;

export const providerStatusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider_id', 'state'],
  properties: {
    provider_id: providerIdSchema,
    state: { type: 'string', enum: PROVIDER_STATES },
    /** Present only when `state` is `contract_error`. A JSON Pointer, never a value. */
    error_path: { type: 'string', maxLength: 120 },
  },
} as const;

/** An opaque, hub-minted identifier. Pattern-constrained for the same reason as resource ids. */
export const opaqueIdSchema = {
  type: 'string',
  pattern: '^[a-z]{1,10}_[A-Za-z0-9]{6,24}$',
  minLength: 8,
  maxLength: 36,
} as const;
