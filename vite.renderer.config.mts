import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Production CSP: same-origin only, no remote origins of any kind. Injected at
// build time so the dev server keeps working with HMR.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'bengkelin:production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: PRODUCTION_CSP,
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  // Relative asset URLs so the built renderer loads from file://.
  base: './',
  plugins: [react(), tailwindcss(), productionCsp()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
