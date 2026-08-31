/**
 * The suite's `test` object: signed-in pages for both users, an anonymous one,
 * and a tripwire against real model calls.
 *
 * Each fixture opens its own browser context from the `storageState` written by
 * the setup project, so no test logs in — logging in is tested once, in
 * `global.setup.ts`, and everything else starts from a session that already
 * exists. That is worth roughly a second per test and, more importantly, means a
 * flaky login cannot fail four unrelated specs.
 */

import { test as base, expect, type Browser, type Page } from '@playwright/test';

import { STORAGE_STATE } from './users';

/**
 * Requests to the real API, per page.
 *
 * Both AI features call the model from server code, so the browser should never
 * reach for `api.anthropic.com` at all — this exists to prove that stays true.
 * If a later change moved a model call into an island, every test would start
 * billing the account, and the only signal would be a slower suite. So the
 * route is registered, the URL recorded, the request aborted, and the fixture
 * fails the test on teardown with the URL in the message.
 */
const modelCalls = new WeakMap<Page, string[]>();

export async function guardModelCalls(page: Page): Promise<void> {
  const calls: string[] = [];
  modelCalls.set(page, calls);

  await page.route('**://api.anthropic.com/**', async (route) => {
    calls.push(route.request().url());
    await route.abort('blockedbyclient');
  });
}

export function realModelCalls(page: Page): string[] {
  return modelCalls.get(page) ?? [];
}

type Fixtures = {
  /** Signed in as user A. The owner in every ownership test. */
  pageA: Page;
  /** Signed in as user B. Exists to be refused. */
  pageB: Page;
  /** No session at all. */
  guest: Page;
};

async function openPage(browser: Browser, storageState: string | undefined): Promise<Page> {
  const context = await browser.newContext(
    storageState === undefined ? {} : { storageState },
  );
  const page = await context.newPage();

  await guardModelCalls(page);

  return page;
}

async function withPage(
  browser: Browser,
  storageState: string | undefined,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await openPage(browser, storageState);

  try {
    await use(page);

    expect(
      realModelCalls(page),
      'the browser requested api.anthropic.com — model calls belong on the server',
    ).toEqual([]);
  } finally {
    await page.context().close();
  }
}

export const test = base.extend<Fixtures>({
  pageA: async ({ browser }, use) => {
    await withPage(browser, STORAGE_STATE.a, use);
  },

  pageB: async ({ browser }, use) => {
    await withPage(browser, STORAGE_STATE.b, use);
  },

  guest: async ({ browser }, use) => {
    await withPage(browser, undefined, use);
  },
});

export { expect } from '@playwright/test';
