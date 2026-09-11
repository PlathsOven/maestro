import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Keep Monaco (VS Code's editor core, ~3-4 MB) in its own chunk so it's
        // only fetched when the lazy-loaded editor surface first mounts — never
        // at app startup. (rolldown wants a function, not an object.)
        manualChunks: (id) => (id.includes('node_modules/monaco-editor') ? 'monaco' : undefined),
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
