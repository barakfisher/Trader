import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API, on the page's own origin - what nginx does for the production image
 * (infra/docker/nginx.conf), done here for the dev server. The browser only ever
 * calls `/api/...` on whatever address it opened the page at, so `localhost`
 * and `127.0.0.1` both work: the session cookie belongs to that address and is
 * sent with every call, with no CORS and no cross-site cookie rule involved.
 *
 * An absolute API address in the bundle was the alternative, and it failed in
 * the expensive direction: sign-in succeeded, the cookie landed on the API's
 * host, and a page opened under the other name got 401 on every request after.
 *
 * Not `VITE_`-prefixed on purpose: it is read here, in Node, and never reaches
 * the bundle. Docker compose points it at the `orchestrator` service.
 */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080';

const apiProxy = {
  '/api': {
    target: API_PROXY_TARGET,
    // /api/holdings reaches the orchestrator as /holdings, as through nginx.
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // reachable from the Docker network
    strictPort: true,
    proxy: apiProxy,
  },
  preview: { port: 5173, host: true, proxy: apiProxy },
});
