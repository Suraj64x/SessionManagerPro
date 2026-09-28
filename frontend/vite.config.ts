import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:47301',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:47301',
        ws: true,
      },
    },
  },
})
