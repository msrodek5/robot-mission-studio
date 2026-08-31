/**
 * Deletes the two test accounts, then proves their rows went with them.
 *
 * `on delete cascade` from `auth.users` is the cleanup mechanism: no table is
 * ever truncated, so nothing outside these two accounts can be caught by it.
 * The count afterwards is what makes that a fact rather than an assumption — a
 * missing cascade on a future table would leave rows behind, and this is the
 * only place that would notice.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';

import { expect, test as teardown } from '@playwright/test';

import { USER_IDS_PATH, countRowsOwnedByTestUsers, deleteTestUsers } from './support/users';

teardown('delete test users and their rows', async () => {
  const userIds = readUserIds();

  await deleteTestUsers();

  if (userIds.length > 0) {
    expect(await countRowsOwnedByTestUsers(userIds)).toEqual({
      layouts: 0,
      missions: 0,
      runs: 0,
    });
  }

  // The saved sessions belong to accounts that no longer exist. Leaving them on
  // disk would let a later `--project=chromium` run start with cookies that
  // 401 everywhere, which reads as an app bug.
  rmSync('tests/e2e/.auth', { recursive: true, force: true });
});

function readUserIds(): string[] {
  if (!existsSync(USER_IDS_PATH)) return [];

  const parsed = JSON.parse(readFileSync(USER_IDS_PATH, 'utf8')) as Record<string, unknown>;

  return Object.values(parsed).filter((value): value is string => typeof value === 'string');
}
