import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => {
  const plugins = [react()];

  // basicSsl is only needed for local dev (localtest.me requires HTTPS)
  // Vercel handles HTTPS in production automatically
  if (command === 'serve') {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
    plugins.push(basicSsl());
  }

  return {
    plugins,
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    }
  };
});
