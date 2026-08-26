/**
 * @threshold/domain
 *
 * The deterministic core: projection, matching, composition, ranking, identifiers. No browser, no
 * network, no model, no clock beyond the fixed search reference. Every rule in here is one a person
 * can be told out loud and can argue with, which is the difference between a decision and an opinion.
 */

export * from './ids';
export * from './projection';
export * from './normalize';
export * from './matching';
export * from './composition';
export * from './ranking';
