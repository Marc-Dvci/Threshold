/**
 * The provider transport. Build plan §47.2.
 *
 * One interface, two implementations, chosen at runtime by probe rather than by user-agent string.
 *
 *  - `WebMcpTransport` uses `getTools({ fromOrigins })` and `executeTool`. This is the path the
 *    entry is about.
 *  - `PostMessageTransport` reaches the *same provider apps, on the same separate origins, in the
 *    same iframes*, over a small typed `postMessage` protocol.
 *
 * Everything above this interface is identical in both cases: the same provider code, the same
 * schemas, the same trust firewall, the same leases, the same consent gate. Only the wire between
 * hub and provider frame changes.
 *
 * The fallback exists because the hub's federation leg is run by the hub's own JavaScript, so it
 * needs those two methods present in whatever browser a judge opens, and nothing published confirms
 * the ChatGPT in-app browser exposes them to page script. Without the fallback, one unverifiable
 * platform assumption decides whether the product works at all.
 *
 * Honesty rule (Invariant L): whichever transport runs, `kind` is surfaced in the UI and in
 * `/verify`. The `postMessage` path is never presented as WebMCP federation. It is still genuinely
 * cross-origin, and that is the accurate thing to say about it.
 */

import { discoverOrigins, type DiscoveredTool, type OriginDiscovery } from './discover';
import { executeWebMCPTool, type ExecuteOutcome } from './execute';
import { hasFederationApi, isWebMCPSupported, noteRuntime, setRuntime } from './support';

export type ExecOptions = { signal?: AbortSignal; timeoutMs?: number };

export interface ProviderTransport {
  readonly kind: 'webmcp' | 'postmessage';
  discover(origins: readonly string[], options?: { timeoutMs?: number }): Promise<OriginDiscovery[]>;
  execute(tool: DiscoveredTool, input: unknown, options?: ExecOptions): Promise<ExecuteOutcome>;
}

// ---------------------------------------------------------------------------
// WebMCP
// ---------------------------------------------------------------------------

export class WebMcpTransport implements ProviderTransport {
  readonly kind = 'webmcp' as const;

  discover(origins: readonly string[], options?: { timeoutMs?: number }) {
    return discoverOrigins(origins, options ?? {});
  }

  execute(tool: DiscoveredTool, input: unknown, options: ExecOptions = {}) {
    return executeWebMCPTool(tool, input, options);
  }
}

// ---------------------------------------------------------------------------
// postMessage fallback
// ---------------------------------------------------------------------------

export const PM_PROTOCOL = 'threshold.transport.v1';

/**
 * The request body, separate from the envelope.
 *
 * Written this way because `Omit<Union, K>` is not distributive: it collapses a union to its common
 * keys, so `Omit<PmRequest, 'protocol' | 'id'>` would silently lose `tool` and `input` and the
 * execute path would fail to type-check for the wrong reason.
 */
export type PmRequestBody =
  | { kind: 'discover' }
  | { kind: 'execute'; tool: string; input: unknown };

export type PmRequest = PmRequestBody & { protocol: typeof PM_PROTOCOL; id: string };

export type PmResponse =
  | {
      protocol: typeof PM_PROTOCOL;
      id: string;
      kind: 'discover:result';
      tools: Array<{ name: string; description?: string; annotations?: ModelContextToolAnnotations }>;
    }
  | { protocol: typeof PM_PROTOCOL; id: string; kind: 'execute:result'; raw: string }
  | { protocol: typeof PM_PROTOCOL; id: string; kind: 'error'; reason: string };

export function isPmResponse(value: unknown): value is PmResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { protocol?: unknown }).protocol === PM_PROTOCOL &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

let pmCounter = 0;
function nextId(): string {
  pmCounter += 1;
  return `pm${pmCounter}`;
}

/** How the hub finds the frame that hosts a given provider origin. */
export type WindowResolver = (origin: string) => Window | null;

export class PostMessageTransport implements ProviderTransport {
  readonly kind = 'postmessage' as const;

  constructor(private readonly resolveWindow: WindowResolver) {}

  /**
   * One request, one response, with the origin checked on the way in.
   *
   * Every listener is removed in `finally`. A `postMessage` bridge that accumulates listeners is a
   * leak that manifests as the *second* search behaving differently from the first, which is a
   * miserable thing to debug on a deadline.
   */
  private request<R extends PmResponse['kind']>(
    origin: string,
    message: PmRequestBody,
    expect: R,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Extract<PmResponse, { kind: R }>> {
    return new Promise((resolve, reject) => {
      const target = this.resolveWindow(origin);
      if (!target) {
        reject(new Error(`no frame is hosting ${origin}`));
        return;
      }

      const id = nextId();
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onMessage = (event: MessageEvent) => {
        // Both checks are required. The origin check stops any other frame answering for this
        // provider; the id check stops a stale reply resolving a newer request.
        if (event.origin !== origin) return;
        if (!isPmResponse(event.data) || event.data.id !== id) return;
        const data = event.data;
        if (data.kind === 'error') {
          finish(() => reject(new Error(data.reason)));
        } else if (data.kind === expect) {
          finish(() => resolve(data as Extract<PmResponse, { kind: R }>));
        } else {
          finish(() => reject(new Error(`expected ${expect}, got ${data.kind}`)));
        }
      };

      const onAbort = () => finish(() => reject(new Error('aborted by caller')));
      const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), timeoutMs);

      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });

      target.postMessage({ ...message, protocol: PM_PROTOCOL, id } as PmRequest, origin);
    });
  }

  async discover(
    origins: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<OriginDiscovery[]> {
    const timeoutMs = options.timeoutMs ?? 4000;
    return Promise.all(
      origins.map(async (origin): Promise<OriginDiscovery> => {
        const started = Date.now();
        try {
          const res = await this.request(origin, { kind: 'discover' }, 'discover:result', timeoutMs);
          const tools: DiscoveredTool[] = res.tools.map((t) => ({
            origin,
            name: t.name,
            // The handle is only meaningful to WebMcpTransport. Over postMessage the name is the
            // address, so a minimal stand-in keeps the shared type honest without pretending to be
            // a RegisteredTool.
            handle: { name: t.name } as RegisteredTool,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
          }));
          return { origin, state: 'ok', tools, ms: Date.now() - started };
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return {
            origin,
            state: reason.includes('timeout') ? 'timeout' : 'unavailable',
            tools: [],
            ms: Date.now() - started,
            reason,
          };
        }
      }),
    );
  }

  async execute(
    tool: DiscoveredTool,
    input: unknown,
    options: ExecOptions = {},
  ): Promise<ExecuteOutcome> {
    const started = Date.now();
    const ms = () => Date.now() - started;
    try {
      const res = await this.request(
        tool.origin,
        { kind: 'execute', tool: tool.name, input },
        'execute:result',
        options.timeoutMs ?? 2000,
        options.signal,
      );
      return { state: 'ok', raw: res.raw, ms: ms() };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (reason.includes('aborted')) return { state: 'aborted', ms: ms() };
      if (reason.includes('timeout')) return { state: 'timeout', ms: ms() };
      return { state: 'failed', ms: ms(), reason };
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Choose a transport by probing, never by assuming.
 *
 * The probe is a real `getTools` against a real provider origin, because "the methods exist" and
 * "the methods work across an origin boundary in this browser" are different facts and only the
 * second one matters. `probeOrigin` should be a provider that is definitely loaded.
 */
export async function selectTransport(options: {
  probeOrigin: string;
  resolveWindow: WindowResolver;
  timeoutMs?: number;
}): Promise<ProviderTransport> {
  const supported = isWebMCPSupported();

  if (supported && hasFederationApi()) {
    const [probe] = await discoverOrigins([options.probeOrigin], {
      timeoutMs: options.timeoutMs ?? 4000,
    });
    if (probe && probe.state === 'ok' && probe.tools.length > 0) {
      setRuntime('transport', 'webmcp');
      noteRuntime(`transport: WebMCP federation (probe found ${probe.tools.length} tools)`);
      return new WebMcpTransport();
    }
    const why =
      probe === undefined
        ? 'probe did not run'
        : probe.state === 'ok'
          ? 'origin answered with no tools'
          : (probe.reason ?? probe.state);
    noteRuntime(`transport: WebMCP present but cross-origin discovery failed (${why}); falling back`);
  } else {
    noteRuntime(
      supported
        ? 'transport: modelContext present but getTools/executeTool are not; falling back'
        : 'transport: no document.modelContext; falling back',
    );
  }

  setRuntime('transport', 'postmessage');
  return new PostMessageTransport(options.resolveWindow);
}
