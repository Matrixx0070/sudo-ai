import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // renderer source is the Vite root; index.html must live here
  root: 'src/renderer',
  base: './',
  build: {
    // output goes to dist/renderer, separate from main-process dist
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/renderer/index.html'),
        admin: path.resolve(__dirname, 'src/renderer/admin/index.html'),
        chat: path.resolve(__dirname, 'src/renderer/chat/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      // allows imports like: import Foo from '@renderer/components/Foo'
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared-types': path.resolve(__dirname, 'shared-types'),
    },
  },
  server: {
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:18900',
        changeOrigin: true,
      },
      '/chat/ws': {
        target: 'ws://127.0.0.1:18900',
        ws: true,
      },
    },
  },
});
