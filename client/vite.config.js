import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Version comes from client/package.json, which scripts/sync-version.mjs keeps
// equal to the root VERSION file (the single source of truth). Reading the
// client package (always present, incl. in the Docker build) keeps this robust.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// Vite 8 bundles with rolldown; manual chunking is `output.codeSplitting.groups`
// (the rollup `manualChunks` function is deprecated there).
const chunkGroups = [
  { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
  { name: 'xterm', test: /[\\/]node_modules[\\/]@xterm[\\/]/, priority: 20 },
  { name: 'highlight', test: /[\\/]node_modules[\\/]highlight\.js[\\/]/, priority: 20 },
  { name: 'argocd', test: /[\\/]src[\\/]components[\\/]ArgoCD\.jsx$/, priority: 10 },
  { name: 'security', test: /[\\/]src[\\/]components[\\/]SecurityCenter\.jsx$/, priority: 10 },
  { name: 'topology', test: /[\\/]src[\\/]components[\\/]Topology\.jsx$/, priority: 10 },
];

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: chunkGroups },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true
      }
    }
  }
});
