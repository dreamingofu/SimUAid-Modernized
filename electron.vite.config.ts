import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // The renderer root is src/renderer, but it imports the shared menu
    // descriptor from src/shared. Allow Vite's dev server to read the project
    // root so that cross-directory import resolves during development.
    server: {
      fs: {
        allow: [resolve('.')]
      }
    },
    plugins: [react()]
  }
})
