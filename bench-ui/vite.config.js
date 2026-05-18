import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 7901,
    strictPort: false,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7900',
        changeOrigin: true,
      },
      // For "Play game" links - proxy the run folders too
      '/bench_': {
        target: 'http://127.0.0.1:7900',
        changeOrigin: true,
      },
    },
  },
});
