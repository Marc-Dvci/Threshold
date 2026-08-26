/**
 * @threshold/lease-store
 *
 * The provider-side authority on whether an organisation holds a resource. Server-side, atomic
 * within a process, expiry decided at read time. Invariants E and F.
 *
 * The HTTP mounting is at `@threshold/lease-store/http`, not here, so that browser-side packages
 * importing these types do not transitively require Node's type definitions.
 */

export * from './store';
