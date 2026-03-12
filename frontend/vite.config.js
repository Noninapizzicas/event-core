import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Puertos configurables via .env (start.sh los exporta como VITE_*)
const BACKEND_PORT = process.env.VITE_BACKEND_PORT || process.env.EVENT_CORE_PORT || 3000;
const MQTT_WS_PORT = process.env.VITE_MQTT_WS_PORT || process.env.EVENT_CORE_BROKER_WS_PORT || 9001;
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '5173', 10);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: FRONTEND_PORT,
    host: true, // Escuchar en todas las interfaces
    proxy: {
      // Proxy para APIs del backend
      '/modules': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
        secure: false
      },
      // Proxy para WebSocket MQTT
      '/mqtt': {
        target: `ws://127.0.0.1:${MQTT_WS_PORT}`,
        ws: true,
        secure: false
      }
    }
  }
});
