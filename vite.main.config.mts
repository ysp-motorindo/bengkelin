import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      // Native module: loaded from node_modules at runtime (unpacked from asar).
      external: ['better-sqlite3'],
    },
  },
});
