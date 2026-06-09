import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/main/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', '.pai'],
  },
})
