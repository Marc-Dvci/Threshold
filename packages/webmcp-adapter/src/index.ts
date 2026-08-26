/**
 * @threshold/webmcp-adapter
 *
 * Every direct `document.modelContext` call in the project lives in this package. Business logic
 * never touches the platform API, so an API change is one package's problem rather than nine tool
 * handlers' problem. Build plan §24.
 */

export * from './support.js';
export * from './encode.js';
export * from './register.js';
export * from './lifecycle.js';
export * from './discover.js';
export * from './execute.js';
export * from './transport.js';
export * from './provider-host.js';
