/**
 * Creates the two test accounts and parks a logged-in session for each.
 *
 * A setup *project* rather than `globalSetup`, because logging in needs the app
 * to be up and only a project is guaranteed to run after Playwright's
 * `webServer` is ready. It is paired with `global.teardown.ts` through the
 * `teardown` field in `playwright.config.ts`, so the accounts are removed even
 * when the suite fails.
 *
 * Logging in happens through the real form on `/login` — the one place in the
 * suite that does — so the cookies in the saved state are the ones the
 * middleware actually issues, session refresh and all. Faking them by calling
 * the Supabase SDK here would produce a token the SSR client might not accept,
 * and the first failure would look like an app bug.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

import {
  STORAGE_STATE,
  TEST_PASSWORD,
  USER_A_EMAIL,
  USER_B_EMAIL,
  USER_IDS_PATH,
  createTestUsers,
} from './support/users';

setup('create test users and store their sessions', async ({ browser, baseURL }) => {
  const users = await createTestUsers();

  mkdirSync(dirname(USER_IDS_PATH), { recursive: true });
  writeFileSync(USER_IDS_PATH, JSON.stringify({ a: users.a.id, b: users.b.id }, null, 2));

  for (const [email, statePath] of [
    [USER_A_EMAIL, STORAGE_STATE.a],
    [USER_B_EMAIL, STORAGE_STATE.b],
  ] as const) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();

    // The redirect chain is /login -> /app -> /app/layouts. Waiting for the
    // heading rather than the URL means a session that is written but not yet
    // readable by the middleware fails here, loudly, instead of in a spec.
    await expect(page.getByRole('heading', { name: 'Layouts', level: 1 })).toBeVisible();

    await context.storageState({ path: statePath });
    await context.close();
  }
});
