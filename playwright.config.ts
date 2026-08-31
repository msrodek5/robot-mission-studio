/**
 * Playwright configuration — M7.
 *
 * Two things here are worth knowing before changing anything.
 *
 * **The app is served from the production build, not `astro dev`.**
 * `astro preview` does not work with `@astrojs/vercel` (no preview entrypoint),
 * so `tests/e2e/support/serve-build.mjs` boots `.vercel/output` behind a plain
 * `node:http` port. The suite therefore runs against the artefact that ships,
 * which is the whole point of an E2E suite that gates a deploy.
 *
 * **No test makes a real model call.** Both AI features call Anthropic from
 * server code, where `page.route` cannot reach them, so the seam is
 * `ANTHROPIC_BASE_URL` — pointed at `tests/e2e/support/anthropic-stub.mjs`
 * below. Everything downstream of the model runs for real: the Zod gate, the
 * repair loop, `validateMission`, the insert, and the RLS-scoped read back. A
 * `page.route` tripwire in `tests/e2e/support/fixtures.ts` fails any test in
 * which the *browser* reaches for `api.anthropic.com`.
 */

import { defineConfig, devices } from '@playwright/test';

import { loadDotEnv, optionalEnv, requireEnv } from './tests/e2e/support/env';

loadDotEnv();

/**
 * 4331, not Astro's default 4321.
 *
 * `reuseExistingServer` is on locally, and on the default port it happily
 * adopted a developer's `astro dev` — which serves unbundled modules through
 * Vite and had a stale optimize-dep cache, so islands failed to hydrate and four
 * specs failed for a reason that had nothing to do with the app. A port of our
 * own means "reuse" can only ever reuse this suite's own server.
 */
const BASE_URL = optionalEnv('E2E_BASE_URL', 'http://127.0.0.1:4331');
const APP_PORT = new URL(BASE_URL).port || '80';
const STUB_PORT = optionalEnv('E2E_STUB_PORT', '4399');
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

/**
 * What the built app runs with.
 *
 * `PUBLIC_*` are inlined into the client bundle at build time, so they have to
 * be present for `npm run build`, not just at runtime. `ANTHROPIC_API_KEY` is
 * deliberately a dummy: the stub never looks at it, and the SDK refuses to
 * construct a client without one — so this value existing is what proves the
 * key is not what makes the tests pass.
 */
const appEnv = {
  PUBLIC_SUPABASE_URL: requireEnv('PUBLIC_SUPABASE_URL'),
  PUBLIC_SUPABASE_ANON_KEY: requireEnv('PUBLIC_SUPABASE_ANON_KEY'),
  ANTHROPIC_API_KEY: optionalEnv('ANTHROPIC_API_KEY', 'e2e-stub-key-not-a-real-key'),
  ANTHROPIC_BASE_URL: STUB_URL,
  ANTHROPIC_MODEL: 'e2e-stub-model',
};

export default defineConfig({
  testDir: './tests/e2e',
  // Playwright's default matches every .ts file; the support modules are not
  // tests and would otherwise be reported as empty files.
  testMatch: /.*\.(spec|setup|teardown)\.ts$/,

  fullyParallel: true,
  // A stray `test.only` that passes locally must not silently shrink CI.
  forbidOnly: Boolean(process.env.CI),

  // Two, because a timeout on a cold serverless-style route is the one flake
  // worth retrying and it costs nothing when everything passes.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,

  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github'], ['list']]
    : [['html', { open: 'never' }], ['list']],

  // Generous: a run has to reach Supabase, and the postmortem goes through the
  // stub, the Zod gate, and a write.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts$/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testMatch: /global\.teardown\.ts$/,
    },
    {
      // Chromium only. The app is one browser's worth of surface and the other
      // two engines would triple the CI minutes to re-prove the same assertions.
      name: 'chromium',
      // Specs only. Without this the project also picks up the setup and
      // teardown files — and the teardown, running as an ordinary test, deletes
      // the users out from under everything else.
      testMatch: /.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      name: 'anthropic stub',
      command: 'node tests/e2e/support/anthropic-stub.mjs',
      url: `${STUB_URL}/__health`,
      env: { PORT: STUB_PORT },
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'app',
      command: 'npm run build && npm run e2e:serve',
      url: `${BASE_URL}/api/health`,
      env: { ...appEnv, PORT: APP_PORT },
      // The build is the slow part; 4 minutes is cold-CI headroom, not a target.
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
