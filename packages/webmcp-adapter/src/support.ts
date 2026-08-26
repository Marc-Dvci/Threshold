/**
 * Feature detection, and the runtime report behind `/verify`.
 *
 * Build plan §24.1, §47.
 *
 * The important asymmetry: the hub's federation leg is executed by the hub's own JavaScript, not by
 * the agent. So the agent being able to see the hub's tools tells you nothing about whether the hub
 * can reach a provider's. Those are two separate capabilities and this module probes them
 * separately, because assuming the second from the first is how an entry ships an error banner to a
 * judge.
 */

export type WebMcpCapability = 'absent' | 'present' | 'unknown';

export type RuntimeReport = {
  /** `document.modelContext` exists at all. */
  modelContext: WebMcpCapability;
  /** The page can register its own tools. Proven by actually registering one. */
  register: WebMcpCapability;
  /** The page can enumerate cross-origin tools. Proven by a real `getTools({ fromOrigins })`. */
  getToolsCrossOrigin: WebMcpCapability;
  /** The page can execute a cross-origin tool. Proven by a real round trip. */
  executeToolCrossOrigin: WebMcpCapability;
  /** Which argument encoding `executeTool` accepted. See `execute.ts`. */
  argumentEncoding: 'object' | 'json-string' | 'unknown';
  /** Which transport the product is actually using. */
  transport: 'webmcp' | 'postmessage' | 'none';
  /** Free-form notes for the test matrix. Developer-facing only. */
  notes: string[];
  userAgent: string;
  probedAt: string;
};

const report: RuntimeReport = {
  modelContext: 'unknown',
  register: 'unknown',
  getToolsCrossOrigin: 'unknown',
  executeToolCrossOrigin: 'unknown',
  argumentEncoding: 'unknown',
  transport: 'none',
  notes: [],
  userAgent: typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent,
  probedAt: new Date().toISOString(),
};

export function runtimeReport(): Readonly<RuntimeReport> {
  return report;
}

export function noteRuntime(note: string): void {
  if (!report.notes.includes(note)) report.notes.push(note);
}

export function setRuntime<K extends keyof RuntimeReport>(key: K, value: RuntimeReport[K]): void {
  report[key] = value;
}

/**
 * Is the API present at all?
 *
 * Deliberately not a version check. A user-agent string is a claim about a browser, not a claim
 * about a capability, and the whole point of a feature probe is to stop believing the former.
 */
export function isWebMCPSupported(): boolean {
  const present =
    typeof document !== 'undefined' &&
    typeof document.modelContext === 'object' &&
    document.modelContext !== null &&
    typeof document.modelContext.registerTool === 'function';
  report.modelContext = present ? 'present' : 'absent';
  return present;
}

/** Does the API expose the two federation methods this product's broker needs? */
export function hasFederationApi(): boolean {
  const mc = typeof document === 'undefined' ? undefined : document.modelContext;
  return typeof mc?.getTools === 'function' && typeof mc?.executeTool === 'function';
}

export function modelContext(): ModelContext {
  const mc = typeof document === 'undefined' ? undefined : document.modelContext;
  if (!mc) throw new Error('WebMCP is not available in this document');
  return mc;
}

/**
 * A page cannot use WebMCP unless it is origin-isolated and in a secure context. Reporting *which*
 * precondition failed saves a long afternoon: "WebMCP is not available" and "this page opted out of
 * origin-keyed agent clusters" are very different problems.
 */
export function environmentBlockers(): string[] {
  const blockers: string[] = [];
  if (typeof window === 'undefined') return ['not a browser'];
  if (!window.isSecureContext) blockers.push('not a secure context (HTTPS or localhost required)');
  // `originAgentCluster` is true when the document is origin-keyed. WebMCP is disabled otherwise.
  const oac = (window as { originAgentCluster?: boolean }).originAgentCluster;
  if (oac === false) blockers.push('document is not origin-keyed (Origin-Agent-Cluster: ?0)');
  return blockers;
}
