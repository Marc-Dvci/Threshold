/**
 * Ambient declarations for WebMCP.
 *
 * The API is not in TypeScript's DOM lib, so this file is the type surface the whole project codes
 * against. It is written from the specification IDL rather than from a tutorial:
 *
 * ```
 * interface ModelContext : EventTarget {
 *   Promise<undefined>                registerTool(ModelContextTool tool,
 *                                                 optional ModelContextRegisterToolOptions options = {});
 *   Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
 *   Promise<DOMString>                executeTool(RegisteredTool tool,
 *                                                 optional object inputObject = {},
 *                                                 optional ModelContextExecuteToolOptions options = {});
 *   attribute EventHandler            ontoolchange;
 * }
 * ```
 *
 * Two places where the declarations are deliberately looser than the IDL, because reality is:
 *
 *  1. `executeTool` is `Promise<DOMString>` in the IDL, but Chrome documents that it returns `null`
 *     when the call triggers a navigation. Declared `Promise<string | null>` so the null branch
 *     cannot be forgotten at a call site. Every consumer must handle it.
 *  2. `RegisteredTool` may or may not expose the origin it came from. Rather than depend on that,
 *     `discover.ts` queries one origin at a time so the origin is known by construction. The
 *     optional field here is used when present and never relied on.
 */

declare global {
  /** What a tool's `execute` may return. The spec's example is an MCP-style content block. */
  type ModelContextToolResult =
    | string
    | {
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
      }
    | Record<string, unknown>;

  interface ModelContextToolAnnotations {
    /** Non-mutating. Lets an agent skip a confirmation it does not need. */
    readOnlyHint?: boolean;
    /**
     * Output may be attacker-influenced and should be treated with heightened scrutiny.
     *
     * Threshold sets this `false` on tools whose output has passed the trust firewall, and that is
     * only honest while no provider-authored string can reach the output. Asserted, not assumed:
     * see `tests/security/no-free-form-surface.test.ts`.
     */
    untrustedContentHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  }

  interface ModelContextTool {
    /** 1-128 chars, `[A-Za-z0-9_.-]` only. Chrome guidance: keep it under 30. */
    name: string;
    /** Optional human label. */
    title?: string;
    /** Chrome guidance: under 500 characters. A truncated description is a mis-selected tool. */
    description: string;
    inputSchema: object;
    annotations?: ModelContextToolAnnotations;
    /**
     * **The context argument is optional in practice, whatever the IDL says.**
     *
     * Measured in Chrome 152: a tool invoked through `document.modelContext.executeTool` — which is
     * how the embedding page, and an agent, actually call it — receives the input alone and no
     * second argument. A handler that reads `context.signal` without checking throws
     * `Cannot read properties of undefined`, and the caller is told only that "the script function
     * threw an error". Typing it as always-present is what let that reach a deployment.
     */
    execute: (
      input: unknown,
      context?: { signal?: AbortSignal },
    ) => Promise<ModelContextToolResult> | ModelContextToolResult;
  }

  interface ModelContextRegisterToolOptions {
    /**
     * Origins permitted to see and execute this tool. Secure origins only.
     *
     * Never a wildcard. A provider exposes its tools to exactly one hub origin, and that plus the
     * embedder's `allow="tools"` are the two gates that make federation safe.
     */
    exposedTo?: string[];
    /** Unregisters the tool when aborted. This is how the tool surface becomes a state machine. */
    signal?: AbortSignal;
  }

  interface ModelContextGetToolOptions {
    /**
     * Origins to query. Without it, only tools same-origin with the caller are returned. Secure
     * origins only.
     */
    fromOrigins?: string[];
  }

  interface ModelContextExecuteToolOptions {
    signal?: AbortSignal;
  }

  interface RegisteredTool {
    name: string;
    description?: string;
    title?: string;
    inputSchema?: object;
    annotations?: ModelContextToolAnnotations;
    /** Present in some implementations. Used when available, never depended on. */
    origin?: string;
  }

  interface ModelContext extends EventTarget {
    registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<void>;
    getTools(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
    /** `Promise<DOMString>` in the IDL; `null` when the call triggered a navigation. */
    executeTool(
      tool: RegisteredTool,
      inputObject?: object | string,
      options?: ModelContextExecuteToolOptions,
    ): Promise<string | null>;
    ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null;
  }

  interface Document {
    readonly modelContext?: ModelContext;
  }
}

export {};
