/// <reference path="./webmcp.d.ts" />
/**
 * @threshold/webmcp-adapter
 *
 * Every direct `document.modelContext` call in the project lives in this package. Business logic
 * never touches the platform API, so an API change is one package's problem rather than nine tool
 * handlers' problem. Build plan §24.
 *
 * The reference above is load-bearing. WebMCP is not in TypeScript's DOM lib, so `webmcp.d.ts`
 * declares it globally; a `.d.ts` that nothing imports is a `.d.ts` no consuming package compiles
 * against, and every downstream file would fail on `RegisteredTool` not existing. The reference on
 * the entry point pulls it in for anyone importing this package.
 */

export * from './support';
export * from './encode';
export * from './register';
export * from './lifecycle';
export * from './discover';
export * from './execute';
export * from './transport';
export * from './provider-host';
