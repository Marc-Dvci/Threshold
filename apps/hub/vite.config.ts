import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Threshold hub.
 *
 * No proxy and no backend of its own. That is the architecture, not an omission: the hub holds
 * nothing, so there is nothing for it to serve. Every fact on the page came from a provider origin
 * through the trust firewall, and the only state it keeps is the current session, in memory.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5100,
    strictPort: true,
    // WebMCP only works in an origin-keyed document.
    headers: { 'Origin-Agent-Cluster': '?1' },
  },
  preview: {
    port: 5100,
    strictPort: true,
    headers: { 'Origin-Agent-Cluster': '?1' },
  },
  build: { target: 'es2022', sourcemap: true },
});
