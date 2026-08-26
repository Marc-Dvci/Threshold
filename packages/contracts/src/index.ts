/**
 * @threshold/contracts
 *
 * The shared domain. Schemas are the single source of truth: TypeScript types are derived from
 * them, and Ajv validates against the same objects. Hub and providers both consume this package,
 * so a contract change is a compile error on both sides of the boundary at once.
 */

export * from './vocabulary';
export * from './time';
export * from './envelope';
export * from './types';
export * from './validate';
export * from './contracts';

export * from './schemas/common';
export * from './schemas/need-profile';
export * from './schemas/provider';
export * from './schemas/composition';
export * from './schemas/hub-tools';
