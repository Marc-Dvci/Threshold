/**
 * @threshold/contracts
 *
 * The shared domain. Schemas are the single source of truth: TypeScript types are derived from
 * them, and Ajv validates against the same objects. Hub and providers both consume this package,
 * so a contract change is a compile error on both sides of the boundary at once.
 */

export * from './vocabulary.js';
export * from './time.js';
export * from './envelope.js';
export * from './types.js';
export * from './validate.js';
export * from './contracts.js';

export * from './schemas/common.js';
export * from './schemas/need-profile.js';
export * from './schemas/provider.js';
export * from './schemas/composition.js';
export * from './schemas/hub-tools.js';
