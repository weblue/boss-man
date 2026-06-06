import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = parseInt(process.env.SERVER_PORT ?? '8771', 10);
const uiPort     = parseInt(process.env.UI_PORT     ?? '8770', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: uiPort,
    proxy: {
      '/api':    `http://localhost:${serverPort}`,
      '/health': `http://localhost:${serverPort}`,
    },
  },
});
