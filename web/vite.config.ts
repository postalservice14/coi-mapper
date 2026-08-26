import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The app is fully static — it can be dropped on any host or opened from a subpath.
  base: './',
  server: { open: true },
  build: { target: 'es2022' },
});
