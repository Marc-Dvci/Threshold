/**
 * The provider frames. Build plan §4.4.
 *
 * Each organisation's own website is loaded in an iframe on the hub page. This is not a rendering
 * decision — the frames are one pixel tall and off-screen — it is what makes federation possible at
 * all: a provider's tools are discoverable only while its document is alive in the frame tree, and
 * `getTools({ fromOrigins })` reaches a document, not a URL.
 *
 * Two gates make cross-origin tools work, and this file owns one of them:
 *
 *  - `allow="tools"` here, from the embedder. The Permissions Policy feature is `tools`, and its
 *    default allowlist is `['self']`, so without this attribute a provider frame cannot expose
 *    anything to the page that embeds it however willing it is.
 *  - `exposedTo: [hubOrigin]` at the provider, which is the provider's half and lives in
 *    `ProviderHost`.
 *
 * Neither is a wildcard, in either direction (§23.3).
 *
 * The frames also carry the `postMessage` fallback: `resolveWindow` hands the transport the
 * `contentWindow` for an origin, which is why the fallback reaches *the same provider apps on the
 * same separate origins* rather than a simulation of them.
 */

export type ProviderFrame = {
  origin: string;
  element: HTMLIFrameElement;
  loaded: boolean;
};

export type FrameHostOptions = {
  /** Where to attach the frames. A hidden container; the visible panels are React. */
  container: HTMLElement;
  origins: readonly string[];
  /** How long to wait for the frames before giving up and letting discovery report the truth. */
  graceMs?: number;
};

export class ProviderFrameHost {
  private readonly frames = new Map<string, ProviderFrame>();

  constructor(private readonly options: FrameHostOptions) {}

  /**
   * Mount every provider frame and wait for the grace period.
   *
   * Resolves when every frame has loaded *or* the grace period elapses, whichever is first, and it
   * never rejects. Blocking the product forever on one provider's frame would let a single slow
   * organisation decide whether a person can search at all (§21.3); the honest behaviour is to
   * proceed and let discovery report which origins answered.
   */
  async mount(): Promise<void> {
    const grace = this.options.graceMs ?? 4000;

    const waits = this.options.origins.map(
      (origin) =>
        new Promise<void>((resolve) => {
          const element = document.createElement('iframe');
          // The embedder's half of the two-gate rule. Without it the provider's `exposedTo` has
          // nothing to grant.
          element.setAttribute('allow', 'tools');
          element.setAttribute('title', `${new URL(origin).host} connector`);
          element.setAttribute('aria-hidden', 'true');
          element.setAttribute('tabindex', '-1');
          element.setAttribute('referrerpolicy', 'origin');
          element.src = origin;

          const frame: ProviderFrame = { origin, element, loaded: false };
          this.frames.set(origin, frame);

          element.addEventListener(
            'load',
            () => {
              frame.loaded = true;
              resolve();
            },
            { once: true },
          );
          // A frame that fails to load is a provider that is down. Discovery will say so with the
          // origin named, which is more useful than an exception here.
          element.addEventListener('error', () => resolve(), { once: true });

          this.options.container.appendChild(element);
        }),
    );

    await Promise.race([
      Promise.all(waits).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, grace)),
    ]);
  }

  /** The window for an origin, for the `postMessage` transport. */
  resolveWindow = (origin: string): Window | null => {
    return this.frames.get(origin)?.element.contentWindow ?? null;
  };

  loadedOrigins(): string[] {
    return [...this.frames.values()].filter((f) => f.loaded).map((f) => f.origin);
  }

  /**
   * Reload one provider frame.
   *
   * Used by the demo reset. Assigning `src` again rather than calling `location.reload()` on the
   * child, because the child is cross-origin and the parent has no such reach into it.
   */
  reload(origin: string): void {
    const frame = this.frames.get(origin);
    if (!frame) return;
    frame.loaded = false;
    frame.element.src = origin;
  }

  destroy(): void {
    for (const frame of this.frames.values()) frame.element.remove();
    this.frames.clear();
  }
}
