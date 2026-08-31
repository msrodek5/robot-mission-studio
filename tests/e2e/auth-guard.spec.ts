/**
 * The ownership boundary, from both sides.
 *
 * Two properties, and the second is the one worth having a test for: another
 * user's layout answers **404**, not 403. A 403 would confirm the id names a
 * real row — it would let anyone walk the id space and learn how many layouts
 * exist and which ids are live. Under RLS the row is simply invisible, so "not
 * mine" and "not there" are the same event, and this asserts they stay the same
 * answer.
 *
 * `.ai/robot-mission-studio-implementation-plan.md` section 10 names silently
 * permissive RLS as this project's most likely security bug.
 * `tests/rls/negative-rls.test.ts` proves the policies; this proves the app in
 * front of them does not undo that.
 */

import { callApi, reload, seedLayout, stockedLayout, visit } from './support/app';
import { expect, test } from './support/fixtures';

const LAYOUT_NAME = 'E2E user A private layout';

test('an anonymous visit to /app/layouts is sent to the login form', async ({ guest }) => {
  await guest.goto('/app/layouts');

  // The blocked path rides along so the form can send the user back to it.
  await expect(guest).toHaveURL(/\/login\?redirect=%2Fapp%2Flayouts$/);
  await expect(guest.getByRole('heading', { name: 'Log in', level: 1 })).toBeVisible();

  // No part of the app leaked into the page it was refused from.
  await expect(guest.getByRole('heading', { name: 'Layouts' })).toHaveCount(0);
});

test('an anonymous API call is refused rather than redirected', async ({ guest }) => {
  // Pages redirect because a browser can follow one; endpoints answer 401,
  // because a `fetch` cannot do anything useful with a login page.
  const response = await callApi(guest, 'GET', '/api/layouts');

  expect(response.status).toBe(401);
});

test("user B gets a 404 for user A's layout, not the layout and not a 403", async ({
  pageA,
  pageB,
}) => {
  const layoutId = await seedLayout(pageA, LAYOUT_NAME, stockedLayout());

  // Control: it is a real, reachable layout for the user who owns it. Without
  // this the assertions below would also pass against an id that never existed.
  await visit(pageA, `/app/layouts/${layoutId}`);
  await expect(pageA.getByLabel('Layout name', { exact: true })).toHaveValue(LAYOUT_NAME);

  // The page.
  const page = await pageB.goto(`/app/layouts/${layoutId}`);

  expect(page?.status()).toBe(404);
  expect(page?.status()).not.toBe(403);
  await expect(pageB.getByText(LAYOUT_NAME)).toHaveCount(0);

  // The endpoint behind it, and the child route that takes the same id — a
  // guard that only covered the page would leave the data readable.
  for (const path of [`/api/layouts/${layoutId}`, `/app/layouts/${layoutId}/missions/new`]) {
    const response = await callApi(pageB, 'GET', path);

    expect(response.status, `${path} must be 404 for a non-owner`).toBe(404);
    expect(response.body).not.toContain(LAYOUT_NAME);
  }

  // And writes, so B cannot discover the row by trying to change it.
  const write = await callApi(pageB, 'PUT', `/api/layouts/${layoutId}`, {
    name: 'B was here',
    layout: stockedLayout(),
  });

  expect(write.status).toBe(404);

  // Belt and braces: A's layout is untouched after all of that.
  await reload(pageA);
  await expect(pageA.getByLabel('Layout name', { exact: true })).toHaveValue(LAYOUT_NAME);
});
