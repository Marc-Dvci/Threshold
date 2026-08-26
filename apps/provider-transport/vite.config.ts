import { defineConfig } from 'vite';

/**
 * Provider page for `transport-a`.
 *
 * No workspace imports in this file, on purpose. Vite loads its config through Node, which
 * externalises bare specifiers and then cannot resolve TypeScript sources; anything imported here
 * has to be Node-loadable. The lease API therefore runs as its own process (`pnpm --filter
 * @threshold/provider-transport api`) and this dev server proxies to it, so the page talks to its
 * backend over one origin exactly as it does in production.
 */
export default defineConfig({
  server: {
    port: 5103,
    strictPort: true,
    // WebMCP only works in an origin-keyed document. Sent in dev as well as production so a local
    // run exercises the same precondition as the deployment.
    headers: { 'Origin-Agent-Cluster': '?1' },
    proxy: {
      '/api': {
        target: 'http://localhost:6103',
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5103,
    strictPort: true,
    headers: { 'Origin-Agent-Cluster': '?1' },
    proxy: { '/api': { target: 'http://localhost:6103', changeOrigin: false } },
  },
  build: { target: 'es2022', sourcemap: true },
});
