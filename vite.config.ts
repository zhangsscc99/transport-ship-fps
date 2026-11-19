import { defineConfig } from 'vite';

export default defineConfig({
  base: '/transport/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
});
