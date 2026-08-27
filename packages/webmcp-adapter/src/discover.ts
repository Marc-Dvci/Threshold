/**
 * Cross-origin tool discovery. Build plan §4.6, §21.2.
 *
 * One design decision worth stating, because the obvious implementation is wrong.
 *
 * `getTools({ fromOrigins: [a, b, c] })` returns one flat list. `RegisteredTool` may or may not
 * carry the origin it came from, and the plan requires indexing by `(origin, name)` rather than by
 * name alone: two organisations both offering `hold` is the normal case here, not an edge case.
 *
 * So discovery queries **one origin at a time**. The origin is then known by construction rather
 * than read from a field that may not exist. Two things fall out of it for free:
 *
 *  - one slow or dead origin cannot stall the others, because each query has its own timeout;
 *  - a provider that has gone offline is attributable, which is what makes §45's offline control a
 *    demonstration instead of a mystery.
 *
 * **Measured platform behaviour, Chrome 151.0.7922.34.** `getTools({ fromOrigins: [X] })` returns
 * the calling document's *own* tools as well as X's — `fromOrigins` widens the default allowlist of
 * `['self']` rather than replacing it. Left alone, that puts the hub's own `find_support` in every
 * provider's tool list, and `/verify` would then print a false statement about federation on the one
 * page whose entire job is to be true. Worse, the hub and a provider both publish a tool called
 * `release_hold`, so excluding by name would drop a real provider tool.
 *
 * The same browser does populate `RegisteredTool.origin`, so tools are filtered on it where it is
 * present, and the queried origin stands where it is not. That asymmetry is the reason discovery
 * queries one origin at a time in the first place: the fallback is still correct.
 */

import { hasFederationApi, modelContext, noteRuntime, setRuntime } from './support';

export type DiscoveredTool = {
  /** The origin that owns the tool. Known by construction, never inferred. */
  origin: string;
  name: string;
  /** The handle to pass back to `executeTool`. Opaque; do not reconstruct it. */
  handle: RegisteredTool;
  description?: string;
  annotations?: ModelContextToolAnnotations;
};

export type OriginDiscovery =
  | { origin: string; state: 'ok'; tools: DiscoveredTool[]; ms: number }
  | { origin: string; state: 'timeout' | 'unavailable'; tools: []; ms: number; reason?: string };

const DEFAULT_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Discover the tools one origin exposes to this document. */
export async function discoverOrigin(
  origin: string,
  options: { timeoutMs?: number } = {},
): Promise<OriginDiscovery> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!hasFederationApi()) {
    setRuntime('getToolsCrossOrigin', 'absent');
    return {
      origin,
      state: 'unavailable',
      tools: [],
      ms: 0,
      reason: 'getTools/executeTool not present in this browser',
    };
  }

  try {
    const found = await withTimeout(
      modelContext().getTools({ fromOrigins: [origin] }),
      timeoutMs,
      `getTools(${origin})`,
    );
    const tools: DiscoveredTool[] = found
      // Drop anything the browser attributed to another origin — in practice, this document's own
      // tools, which `fromOrigins` includes alongside the ones asked for.
      .filter((handle) => handle.origin === undefined || handle.origin === origin)
      .map((handle) => ({
        origin,
        name: handle.name,
        handle,
        ...(handle.description !== undefined ? { description: handle.description } : {}),
        ...(handle.annotations !== undefined ? { annotations: handle.annotations } : {}),
      }));
    if (tools.length > 0) setRuntime('getToolsCrossOrigin', 'present');
    return { origin, state: 'ok', tools, ms: Date.now() - started };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const timedOut = reason.includes('timed out');
    noteRuntime(`getTools(${origin}) failed: ${reason}`);
    return {
      origin,
      state: timedOut ? 'timeout' : 'unavailable',
      tools: [],
      ms: Date.now() - started,
      reason,
    };
  }
}

/**
 * Discover every origin concurrently, each with its own timeout.
 *
 * `allSettled` semantics by construction: `discoverOrigin` never rejects, it returns a state. A
 * fan-out where one participant's failure can reject the whole thing is a fan-out that will fail on
 * camera.
 */
export async function discoverOrigins(
  origins: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OriginDiscovery[]> {
  return Promise.all(origins.map((origin) => discoverOrigin(origin, options)));
}

/**
 * Index discovered tools by `(origin, name)`.
 *
 * Never by name alone. Four organisations each offering `hold` is the point of the product.
 */
export function indexByOriginAndName(
  discoveries: readonly OriginDiscovery[],
): Map<string, DiscoveredTool> {
  const index = new Map<string, DiscoveredTool>();
  for (const d of discoveries) {
    for (const tool of d.tools) {
      index.set(toolKey(tool.origin, tool.name), tool);
    }
  }
  return index;
}

export function toolKey(origin: string, name: string): string {
  return `${origin}|${name}`;
}

/** Tools this document itself registered, for the diagnostics panel. */
export async function discoverOwnTools(): Promise<RegisteredTool[]> {
  if (!hasFederationApi()) return [];
  try {
    return await modelContext().getTools();
  } catch {
    return [];
  }
}
