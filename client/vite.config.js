import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read VITE_* from the repo-root .env as well as client/.env
  const env = { ...loadEnv(mode, '..', ''), ...loadEnv(mode, '.', '') };
  return {
    plugins: [react()],
    envDir: '..',
    server: {
      port: 5173,
      proxy: { '/api': env.VITE_DEV_API_PROXY || 'http://localhost:4000' },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
