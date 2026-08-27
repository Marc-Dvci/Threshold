/**
 * A provider's own server. Build plan §5.4, §15.2, §29.
 *
 * Runs the lease store and answers the provider page. Two modes:
 *
 *   --api-only   just the lease API, for development behind a Vite proxy
 *   (default)    lease API plus the built static page, which is the production shape
 *
 * **Why this is a separate process from the web server in development.** It was tempting to mount
 * the API inside the provider's Vite dev server as middleware, and that is what an earlier pass did.
 * It does not work: Vite loads `vite.config.ts` through Node, so any workspace package the config
 * imports is externalised and handed to a resolver that cannot read TypeScript sources. Rather than
 * bend the module graph around a dev-server detail, the API moved out.
 *
 * That turned out to be the better architecture anyway. An organisation's booking system is not its
 * web server, and modelling them as one process was a convenience that happened to also be a fiction.
 * The page now reaches its own backend over HTTP in development exactly as it does in production, so
 * there is one code path rather than two that agree until they do not.
 *
 * The store still lives in ONE process, which is what makes the two-session collision real: every
 * tab pointed at this provider contends for the same inventory.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import type { ProviderOffer } from '@threshold/contracts';
import { LeaseStore } from '@threshold/lease-store';
import { createLeaseApi } from '@threshold/lease-store/http';

import { capacityFromInventory } from './inventory';

export type ProviderServerOptions = {
  label: string;
  inventory: readonly ProviderOffer[];
  port: number;
  /** Serve this directory as static files. Omit for API-only mode. */
  staticDir?: string;
  maxTtlSeconds?: number;
  resetToken?: string;
  /** Where the page is allowed to be framed from, for the production CSP. */
  hubOrigin?: string;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export async function startProviderServer(options: ProviderServerOptions) {
  const capacity = capacityFromInventory(options.inventory);
  const store = new LeaseStore(capacity, {
    ...(options.maxTtlSeconds !== undefined ? { maxTtlSeconds: options.maxTtlSeconds } : {}),
  });

  const api = createLeaseApi(store, {
    seedCapacity: capacity,
    ...(options.resetToken !== undefined ? { resetToken: options.resetToken } : {}),
    onEvent: ({ route, outcome }) => {
      // Route and outcome only. A referral body must never reach a terminal or a log file.
      console.log(`[${options.label}] ${route} -> ${outcome}`);
    },
  });

  const staticRoot = options.staticDir ? resolve(options.staticDir) : null;

  const server = createServer((req, res) => {
    void (async () => {
      // Dev runs the page on a different port and proxies here, so the proxy's preflight and the
      // page's own fetches both need to be answered. Reflected to the single configured page origin,
      // never `*`: this API answers one page.
      const pageOrigin = process.env.THRESHOLD_PAGE_ORIGIN;
      if (pageOrigin) {
        res.setHeader('access-control-allow-origin', pageOrigin);
        res.setHeader('vary', 'origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          });
          res.end();
          return;
        }
      }

      if (await api(req, res)) return;

      if (!staticRoot) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'api-only server' }));
        return;
      }

      // Static serving with the path normalised and confined under the root. A provider page is not
      // a file server, and `..` in a URL is not a thing to find out about later.
      const rawPath = (req.url ?? '/').split('?')[0]!;
      const rel = normalize(decodeURIComponent(rawPath)).replace(/^([/\\])+/, '');
      let filePath = join(staticRoot, rel);
      if (!filePath.startsWith(staticRoot)) {
        res.writeHead(403).end();
        return;
      }

      try {
        const info = await stat(filePath).catch(() => null);
        if (!info || info.isDirectory()) filePath = join(staticRoot, 'index.html');
        const body = await readFile(filePath);
        const headers: Record<string, string> = {
          'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
          // WebMCP requires an origin-keyed document.
          'origin-agent-cluster': '?1',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        };
        if (extname(filePath) === '.html') {
          headers['cache-control'] = 'no-cache';
          if (options.hubOrigin) {
            // The provider page is framed by exactly one origin and no other. The other half of
            // this gate is `exposedTo` on the tools themselves.
            headers['content-security-policy'] = `frame-ancestors 'self' ${options.hubOrigin}`;
          }
        }
        res.writeHead(200, headers);
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
    })();
  });

  await new Promise<void>((ready) => server.listen(options.port, ready));
  console.log(
    `[${options.label}] listening on http://localhost:${options.port}` +
      (staticRoot ? ` (serving ${staticRoot})` : ' (api only)'),
  );
  return { server, store };
}

/** Minimal argv parsing, so a provider's start script has no dependency of its own. */
export function parseServerArgs(argv: readonly string[]): {
  port?: number;
  apiOnly: boolean;
  staticDir?: string;
} {
  const out: { port?: number; apiOnly: boolean; staticDir?: string } = { apiOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = Number(argv[i + 1]);
    else if (arg === '--api-only') out.apiOnly = true;
    else if (arg === '--static') out.staticDir = argv[i + 1];
  }
  // A platform that assigns the port does so through the environment, and it wins over a default
  // baked into a script. An explicit `--port` still wins over both, because that is what a person
  // typing it meant.
  if (out.port === undefined && process.env.PORT) out.port = Number(process.env.PORT);
  return out;
}
