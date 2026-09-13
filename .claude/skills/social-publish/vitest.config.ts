import { defineConfig } from 'vitest/config';

// Skill-local test runner: the repo's vitest.config.ts does not include .claude/skills/.
// Run: npx vitest run --config .claude/skills/social-publish/vitest.config.ts
export default defineConfig({
  test: {
    include: ['.claude/skills/social-publish/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
