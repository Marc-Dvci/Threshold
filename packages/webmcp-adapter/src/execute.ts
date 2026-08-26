/**
 * Cross-origin tool execution. Build plan §2.3, §21.4.
 *
 * Two corrections from revision 1.0 live here, and both are the kind that produce a wrong answer
 * rather than an error.
 *
 * **The return type.** `executeTool` is declared `Promise<DOMString>`, and Chrome documents that it
 * returns `null` when the call triggers a navigation. A `null` read as an empty success is silent
 * data loss: the hub would report "provider answered, no offers" when in fact the provider
 * navigated. So `null` is surfaced as its own outcome and the caller cannot ignore it.
 *
 * **The argument encoding.** The IDL says `optional object inputObject`, and Chrome's prose says
 * arguments are passed "as a valid JSON string". Those are different instructions and only one can
 * be right for a given build. Rather than pick and hope, this module tries the IDL form, falls back
 * to the string form once on a shape-related failure, and latches whichever worked so the cost is
 * paid once per session. What it latched is reported to `/verify` and belongs in
 * `docs/RUNTIME_TEST_MATRIX.md`, because it is a real platform observation.
 */

import { modelContext, noteRuntime, setRuntime } from './support';
import type { DiscoveredTool } from './discover';

export type ExecuteOutcome =
  | { state: 'ok'; raw: string; ms: number }
  | { state: 'navigated'; ms: number }
  | { state: 'timeout'; ms: number }
  | { state: 'aborted'; ms: number }
  | { state: 'failed'; ms: number; reason: string };

const DEFAULT_TIMEOUT_MS = 2000;

type ArgEncoding = 'object' | 'json-string';
let latchedEncoding: ArgEncoding | null = null;

/** Reset the latch. Tests only: a latch that survives between cases hides a regression. */
export function resetArgumentEncodingLatch(): void {
  latchedEncoding = null;
  setRuntime('argumentEncoding', 'unknown');
}

/**
 * Does this failure look like the browser disagreeing about the argument *shape*, as opposed to the
 * provider tool rejecting the argument *content*?
 *
 * Deliberately narrow. Retrying a provider's legitimate validation failure with a different
 * encoding would turn one clean rejection into two calls and a confusing log, and against a
 * mutating tool it would be worse than confusing.
 */
function looksLikeEncodingMismatch(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes('not an object') ||
    r.includes('cannot convert') ||
    r.includes('is not a valid') ||
    r.includes('failed to execute') ||
    r.includes('typeerror') ||
    r.includes('argument')
  );
}

async function callOnce(
  tool: DiscoveredTool,
  input: unknown,
  encoding: ArgEncoding,
  signal: AbortSignal,
): Promise<string | null> {
  const payload: object | string =
    encoding === 'json-string' ? JSON.stringify(input) : (input as object);
  return modelContext().executeTool(tool.handle, payload, { signal });
}

/**
 * Execute a cross-origin tool.
 *
 * Never throws. Every outcome, including cancellation, is a value: a fan-out across independent
 * organisations must not be able to reject as a whole because one participant misbehaved
 * (Invariant H).
 */
export async function executeWebMCPTool(
  tool: DiscoveredTool,
  input: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExecuteOutcome> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ms = () => Date.now() - started;

  // One controller that the caller's signal, our timeout, and a successful return all feed into, so
  // a pending provider call is never left running after we have stopped caring about it.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(new Error('aborted by caller'));
  if (options.signal) {
    if (options.signal.aborted) return { state: 'aborted', ms: ms() };
    options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  };

  const order: ArgEncoding[] = latchedEncoding
    ? [latchedEncoding]
    : ['object', 'json-string'];

  let lastReason = 'unknown';

  try {
    for (let attempt = 0; attempt < order.length; attempt += 1) {
      const encoding = order[attempt]!;
      try {
        const raw = await callOnce(tool, input, encoding, controller.signal);

        if (latchedEncoding !== encoding) {
          latchedEncoding = encoding;
          setRuntime('argumentEncoding', encoding);
          noteRuntime(`executeTool accepted arguments as ${encoding}`);
        }
        setRuntime('executeToolCrossOrigin', 'present');

        // The null branch. Not an empty success.
        if (raw === null) {
          noteRuntime(`executeTool(${tool.origin}|${tool.name}) returned null: navigation`);
          return { state: 'navigated', ms: ms() };
        }
        return { state: 'ok', raw, ms: ms() };
      } catch (e) {
        if (options.signal?.aborted) return { state: 'aborted', ms: ms() };
        const reason = e instanceof Error ? e.message : String(e);
        if (reason === 'timeout' || reason.includes('timeout')) {
          return { state: 'timeout', ms: ms() };
        }
        lastReason = reason;
        const canRetry = attempt + 1 < order.length && looksLikeEncodingMismatch(reason);
        if (!canRetry) break;
        noteRuntime(`executeTool retrying with json-string encoding after: ${reason}`);
      }
    }
    return { state: 'failed', ms: ms(), reason: lastReason };
  } finally {
    cleanup();
  }
}
