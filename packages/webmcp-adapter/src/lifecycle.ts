/**
 * The tool lifecycle manager. Build plan §13.4, and the correction in §13.3.
 *
 * Owns one `AbortController` per registered tool, so unregistering is aborting a signal and the
 * whole tool surface becomes a function of application state.
 *
 * The correction matters as much as the mechanism. Revision 1.0 used unregistration for two
 * different jobs:
 *
 *   1. **Order enforcement.** `place_plan_holds` should not exist before a feasible plan exists.
 *      The agent cannot call step three before step two because step three is not in its tool list.
 *      This is a genuine platform capability, it is worth showing, and this class does it.
 *
 *   2. **Concurrency control.** Unregistering `make_referral` *during its own execution* to prevent
 *      a duplicate consent flow. This is the wrong tool for that job: it is the exact edge the
 *      Chrome 153 in-flight-execution change touches, and a host agent that watches a tool vanish
 *      mid-conversation can behave in ways no local test reveals. Concurrency belongs to the state
 *      machine, which returns STATE_CONFLICT.
 *
 * So: `reconcile` is driven by state *transitions*, never from inside a tool handler. `assertNotInHandler`
 * makes that a runtime error rather than a convention, because a convention is what gets broken at
 * midnight.
 */

import { registerWebMCPTool } from './register.js';

export type ToolDefinition = {
  tool: ModelContextTool;
  options?: Omit<ModelContextRegisterToolOptions, 'signal'>;
};

type Registration = {
  name: string;
  controller: AbortController;
};

export type LifecycleEvent =
  | { type: 'registered'; name: string }
  | { type: 'unregistered'; name: string }
  | { type: 'noop'; desired: readonly string[] };

export class ToolLifecycle {
  private readonly registrations = new Map<string, Registration>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly listeners = new Set<(e: LifecycleEvent) => void>();
  private inHandler = 0;
  private reconciling: Promise<void> = Promise.resolve();

  constructor(definitions: readonly ToolDefinition[]) {
    for (const def of definitions) this.definitions.set(def.tool.name, def);
  }

  /** Tool names currently visible to an agent. Rendered by the diagnostics panel and `/verify`. */
  registered(): readonly string[] {
    return [...this.registrations.keys()].sort();
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  observe(listener: (e: LifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: LifecycleEvent): void {
    for (const l of this.listeners) l(e);
  }

  /**
   * Wrap a tool handler so the lifecycle knows when it is inside one.
   *
   * The counter is what makes the §13.3 correction enforceable: calling `reconcile` from inside a
   * handler is the mistake, so it throws.
   */
  guard<T>(fn: () => Promise<T>): Promise<T> {
    this.inHandler += 1;
    return fn().finally(() => {
      this.inHandler -= 1;
    });
  }

  private assertNotInHandler(): void {
    if (this.inHandler > 0) {
      throw new Error(
        'ToolLifecycle.reconcile() called from inside a tool handler. Registration is driven by ' +
          'state transitions, not from within an execution: unregistering a tool during its own ' +
          'execution is the Chrome 153 in-flight edge. Use a STATE_CONFLICT check for concurrency.',
      );
    }
  }

  /**
   * Bring the registered set in line with `desired`.
   *
   * Serialised: reconciliations queue behind each other. Two state transitions arriving in the same
   * microtask must not interleave a register and an abort for the same name, or the surface ends up
   * in neither state.
   */
  reconcile(desired: readonly string[]): Promise<void> {
    this.assertNotInHandler();
    const run = async () => {
      const want = new Set(desired);

      for (const [name, reg] of [...this.registrations]) {
        if (!want.has(name)) {
          reg.controller.abort();
          this.registrations.delete(name);
          this.emit({ type: 'unregistered', name });
        }
      }

      let changed = false;
      for (const name of desired) {
        if (this.registrations.has(name)) continue;
        const def = this.definitions.get(name);
        if (!def) throw new Error(`no definition for tool "${name}"`);
        const controller = new AbortController();
        await registerWebMCPTool(def.tool, { ...def.options, signal: controller.signal });
        this.registrations.set(name, { name, controller });
        this.emit({ type: 'registered', name });
        changed = true;
      }
      if (!changed && this.registrations.size === want.size) {
        this.emit({ type: 'noop', desired });
      }
    };

    this.reconciling = this.reconciling.then(run, run);
    return this.reconciling;
  }

  /** Abort every registration. Used on teardown and by tests. */
  async unregisterAll(): Promise<void> {
    for (const [name, reg] of [...this.registrations]) {
      reg.controller.abort();
      this.registrations.delete(name);
      this.emit({ type: 'unregistered', name });
    }
    await this.reconciling.catch(() => undefined);
  }
}
