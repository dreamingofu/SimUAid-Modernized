import { defineConfig } from 'vitest/config'
import { version } from './package.json'

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false
  }
})
