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
  },
  resolve: {
    alias: {
      // allows imports like: import Foo from '@renderer/components/Foo'
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
