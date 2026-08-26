/**
 * The provider side of the boundary. Build plan §4.5, §45, §47.2.
 *
 * One set of tool definitions, served two ways: registered with WebMCP under an `exposedTo`
 * allowlist, and answered over the `postMessage` fallback. The *same* `execute` function backs both,
 * which is what makes the fallback honest rather than a second implementation that might behave
 * differently on camera.
 *
 * Also the home of the offline control (§45). Going offline aborts the registration signal, so the
 * provider's tools genuinely disappear and the hub finds out through `toolchange` rather than by
 * catching an error. That distinction is the whole demonstration: a hub that *notices* a provider
 * leaving is showing federation; a hub that catches an exception is showing error handling.
 */

import { encodeProviderResult } from './encode.js';
import { registerWebMCPTool } from './register.js';
import { isWebMCPSupported } from './support.js';
import { PM_PROTOCOL, type PmRequest, type PmResponse } from './transport.js';

export type ProviderToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations?: ModelContextToolAnnotations;
  /**
   * The handler. Returns a plain value; the host encodes it.
   *
   * Returning a value rather than an encoded envelope is deliberate: a provider author should not
   * have to know that the federation leg is `Promise<DOMString>`, and a provider that stringifies
   * its own results is a provider that will one day stringify them differently.
   */
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown> | unknown;
};

export type ProviderHostOptions = {
  /** The exact hub origin. Never a wildcard: §23.3. */
  hubOrigin: string;
  /** Called whenever online state changes, so the provider page can render its own banner. */
  onStateChange?: (online: boolean) => void;
};

export class ProviderHost {
  private controller: AbortController | null = null;
  private online = false;
  private pmInstalled = false;
  private readonly byName = new Map<string, ProviderToolDefinition>();

  constructor(
    private readonly definitions: readonly ProviderToolDefinition[],
    private readonly options: ProviderHostOptions,
  ) {
    for (const def of definitions) this.byName.set(def.name, def);
  }

  isOnline(): boolean {
    return this.online;
  }

  toolNames(): readonly string[] {
    return this.definitions.map((d) => d.name);
  }

  /**
   * Register every tool and start answering.
   *
   * The `postMessage` responder is installed unconditionally and once, because the *hub* decides
   * which transport it uses and the provider does not get to know. A provider that only answered
   * over the transport it guessed the hub would pick would be a provider that fails in exactly the
   * browser nobody tested.
   */
  async goOnline(): Promise<void> {
    if (this.online) return;

    this.installPostMessageResponder();

    if (isWebMCPSupported()) {
      const controller = new AbortController();
      this.controller = controller;
      for (const def of this.definitions) {
        await registerWebMCPTool(
          {
            name: def.name,
            ...(def.title !== undefined ? { title: def.title } : {}),
            description: def.description,
            inputSchema: def.inputSchema,
            ...(def.annotations !== undefined ? { annotations: def.annotations } : {}),
            execute: async (input, ctx) => encodeProviderResult(await def.execute(input, ctx)),
          },
          {
            // Two gates make federation safe, and this is the provider's half of it: exactly one
            // origin, named. The embedder's `allow="tools"` is the other half.
            exposedTo: [this.options.hubOrigin],
            signal: controller.signal,
          },
        );
      }
    }

    this.online = true;
    this.options.onStateChange?.(true);
  }

  /**
   * The offline control.
   *
   * Aborting the registration signal removes the tools from the accessible set, which fires
   * `toolchange` on the hub. The `postMessage` responder starts refusing at the same moment, so the
   * provider is offline on both transports and the demonstration reads the same either way.
   */
  goOffline(): void {
    if (!this.online) return;
    this.controller?.abort();
    this.controller = null;
    this.online = false;
    this.options.onStateChange?.(false);
  }

  async toggle(): Promise<boolean> {
    if (this.online) {
      this.goOffline();
    } else {
      await this.goOnline();
    }
    return this.online;
  }

  private installPostMessageResponder(): void {
    if (this.pmInstalled) return;
    this.pmInstalled = true;

    window.addEventListener('message', (event: MessageEvent) => {
      // The origin check is the security boundary for this transport. It is the postMessage
      // equivalent of `exposedTo`, and it is not optional: without it any page that can frame this
      // one could drive its tools.
      if (event.origin !== this.options.hubOrigin) return;

      const data = event.data as PmRequest | undefined;
      if (!data || data.protocol !== PM_PROTOCOL || typeof data.id !== 'string') return;

      const reply = (response: PmResponse) => {
        (event.source as Window | null)?.postMessage(response, this.options.hubOrigin);
      };

      if (!this.online) {
        reply({ protocol: PM_PROTOCOL, id: data.id, kind: 'error', reason: 'provider is offline' });
        return;
      }

      if (data.kind === 'discover') {
        reply({
          protocol: PM_PROTOCOL,
          id: data.id,
          kind: 'discover:result',
          tools: this.definitions.map((d) => ({
            name: d.name,
            description: d.description,
            ...(d.annotations !== undefined ? { annotations: d.annotations } : {}),
          })),
        });
        return;
      }

      if (data.kind === 'execute') {
        const def = this.byName.get(data.tool);
        if (!def) {
          reply({
            protocol: PM_PROTOCOL,
            id: data.id,
            kind: 'error',
            reason: `no such tool: ${data.tool}`,
          });
          return;
        }
        const controller = new AbortController();
        void Promise.resolve()
          .then(() => def.execute(data.input, { signal: controller.signal }))
          .then((value) => {
            reply({
              protocol: PM_PROTOCOL,
              id: data.id,
              kind: 'execute:result',
              raw: encodeProviderResult(value),
            });
          })
          .catch((e: unknown) => {
            reply({
              protocol: PM_PROTOCOL,
              id: data.id,
              kind: 'error',
              reason: e instanceof Error ? e.message : String(e),
            });
          });
      }
    });
  }
}
