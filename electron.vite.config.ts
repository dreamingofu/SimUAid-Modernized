import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    // The renderer root is src/renderer, but it imports the shared menu
    // descriptor from src/shared. Allow Vite's dev server to read the project
    // root so that cross-directory import resolves during development.
    server: {
      fs: {
        allow: [resolve('.')]
      }
    },
    plugins: [react(), {
      name: 'production-content-security-policy',
      apply: 'build',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
        },
        injectTo: 'head-prepend'
      }]
    }]
  }
})
