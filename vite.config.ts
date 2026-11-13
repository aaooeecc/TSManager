import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
    },
  ],
  build: {
    outDir: mode === 'web' ? 'web-dist' : 'renderer-dist',
    rollupOptions: {
      input: mode === 'web' ? resolve('preview.html') : undefined,
      output: { manualChunks: { terminal: ['@xterm/xterm', '@xterm/addon-fit'] } },
    },
  },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
}))
