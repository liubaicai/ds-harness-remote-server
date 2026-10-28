import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Scope to the real suite — stray worktree copies (e.g. under .agents/)
    // must not be collected.
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
