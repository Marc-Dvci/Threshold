/**
 * The two encoders. Build plan §8.3, §2.3.
 *
 * Revision 1.0 had one, and that was the conflation this file exists to prevent: a tool's own
 * `execute` return value and `executeTool`'s return value are different channels with different
 * types, and treating them as one produces a bug that only shows up across an origin boundary.
 *
 *   agent  --calls-->  hub tool.execute()      returns ModelContextToolResult   (shape: runtime-dependent)
 *   hub    --calls-->  executeTool(providerTool)  returns Promise<string | null>  (always a string)
 *
 * Business logic never touches either. It returns `ToolResult<T>` and these functions decide how
 * that crosses a wire.
 */

import type { ToolResult } from '@threshold/contracts';

// ---------------------------------------------------------------------------
// Agent-facing
// ---------------------------------------------------------------------------

export type AgentResultShape = 'mcp-content-block' | 'json-string';

/**
 * Which shape hub tools return to the agent.
 *
 * The spec's own example returns an MCP-style content block and Chrome's samples also accept a bare
 * string, so both work in Chrome today. The content block is the canonical shape and the one most
 * likely to survive whichever agent reads it, so it is the default. Spike D exists to confirm that
 * against the ChatGPT in-app browser and, if it disagrees, this is the single line that changes.
 */
let agentResultShape: AgentResultShape = 'mcp-content-block';

export function setAgentResultShape(shape: AgentResultShape): void {
  agentResultShape = shape;
}

export function getAgentResultShape(): AgentResultShape {
  return agentResultShape;
}

/**
 * Encode a business result for the agent.
 *
 * Compact JSON, no pretty-printing. Chrome's guidance is roughly 1.5K per tool output and
 * indentation is a third of that spent on whitespace.
 */
export function encodeToolResult(value: ToolResult<unknown, unknown>): ModelContextToolResult {
  const text = JSON.stringify(value);
  if (agentResultShape === 'json-string') return text;
  return {
    content: [{ type: 'text', text }],
    // Surfacing failure at the protocol level as well as in the payload. An agent that reads only
    // the flag still knows something went wrong; one that reads the payload gets the reason.
    ...(value.ok ? {} : { isError: true }),
  };
}

/** Byte length of what an agent will actually receive. Used by the output-budget tests. */
export function encodedSize(value: ToolResult<unknown, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ---------------------------------------------------------------------------
// Federation-facing
// ---------------------------------------------------------------------------

/**
 * Encode a provider result for the federation leg.
 *
 * Always a compact JSON string, and not by preference: `executeTool` is declared
 * `Promise<DOMString>`, so a provider tool that returns an object is relying on the browser to
 * stringify it in an unspecified way. Doing it here means the hub parses exactly what the provider
 * produced.
 */
export function encodeProviderResult(value: unknown): string {
  return JSON.stringify(value);
}
