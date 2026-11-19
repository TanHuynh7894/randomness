import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The BLS code is shared with the node, so that the page checks exactly what the node signs.
  // Resolved from here, so the page builds without node/node_modules. viem keeps its own older @noble/curves.
  resolve: {
    dedupe: ['viem'],
    alias: { '@noble/curves/bn254.js': fileURLToPath(new URL('node_modules/@noble/curves/bn254.js', import.meta.url)) },
  },
  server: { host: '127.0.0.1', fs: { allow: ['..'] } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
} as Parameters<typeof defineConfig>[0]);
