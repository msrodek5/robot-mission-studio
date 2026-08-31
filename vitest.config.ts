import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live outside src/ so the sim core stays free of test imports.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',

    /**
     * Coverage is measured over `src/lib/**` only, and that is a claim rather
     * than an oversight.
     *
     * `src/pages` and `src/components` are not in scope because no unit test
     * renders them — they are covered by the Playwright suite, and including
     * them here would produce a headline number that falls every time a page
     * gains a line, while saying nothing about whether the page works. What is
     * in scope is the code where a wrong answer is silent: the simulator, the
     * validators, the schemas, and the LLM parsing layer.
     *
     * `json-summary` is what `scripts/ci-summary.mjs` reads to put the sim
     * core's line coverage in the CI job summary.
     */
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/lib/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
});
