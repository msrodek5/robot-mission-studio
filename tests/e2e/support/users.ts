/**
 * The two test users, and the service-role client that owns their lifecycle.
 *
 * **Read this before pointing the suite at a Supabase project.** The teardown
 * deletes users by email, and `on delete cascade` from `auth.users` takes their
 * layouts, missions, and runs with them. That is the whole cleanup mechanism:
 * nothing is deleted by table, so nothing outside these two accounts can be
 * caught by it. The `test_` prefix is the safety property — an account that does
 * not start with it is never touched, even if the suite is pointed at a project
 * that also holds real data.
 *
 * The service-role key appears here and nowhere else. Tests drive the app as
 * real signed-in users over the anon key, exactly like `tests/rls`: an assertion
 * made through the admin client would bypass RLS and prove nothing.
 */

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

import { requireEnv } from './env';

/**
 * The prefix the teardown matches on. Changing it without changing the
 * addresses below would leave rows behind on every run.
 */
export const TEST_EMAIL_PREFIX = 'test_e2e_';

export const USER_A_EMAIL = `${TEST_EMAIL_PREFIX}a@example.com`;
export const USER_B_EMAIL = `${TEST_EMAIL_PREFIX}b@example.com`;

/**
 * Fixed, and that is fine: these accounts exist for the length of one CI run
 * against a project that holds nothing but test data.
 */
export const TEST_PASSWORD = 'e2e-test-password-4d71';

export const TEST_EMAILS = [USER_A_EMAIL, USER_B_EMAIL] as const;

/**
 * Where the setup project records the two user ids for the teardown to check.
 *
 * It lives here rather than in `global.setup.ts` because Playwright refuses to
 * let one test file import another, and the teardown needs the same constant.
 */
export const USER_IDS_PATH = 'tests/e2e/.auth/users.json';

/** Where each user's cookies are parked between the setup project and the tests. */
export const STORAGE_STATE = {
  a: 'tests/e2e/.auth/user-a.json',
  b: 'tests/e2e/.auth/user-b.json',
} as const;

function adminClient(): SupabaseClient {
  return createClient(requireEnv('PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Creates both users with their email pre-confirmed.
 *
 * Pre-confirmed because a plain `signUp` returns no session on a project with
 * email confirmation switched on, which would leave the login step below with
 * nothing to save. Existing accounts are deleted first so an interrupted run
 * cannot leave a half-populated user behind and make the next run's assertions
 * depend on it.
 */
export async function createTestUsers(): Promise<{ a: User; b: User }> {
  await deleteTestUsers();

  return {
    a: await createConfirmedUser(USER_A_EMAIL),
    b: await createConfirmedUser(USER_B_EMAIL),
  };
}

async function createConfirmedUser(email: string): Promise<User> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });

  if (error !== null || data.user === null) {
    throw new Error(`Could not create ${email}: ${error?.message ?? 'no user returned'}`);
  }

  return data.user;
}

/**
 * Deletes every account whose email is one of the two above.
 *
 * Matched against the explicit list rather than a `startsWith` on the prefix, so
 * a stray `test_e2e_someone_elses` account is left alone too.
 */
export async function deleteTestUsers(): Promise<void> {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

  if (error !== null) throw new Error(`Could not list users: ${error.message}`);

  const targets = data.users.filter(
    (user) => user.email !== undefined && (TEST_EMAILS as readonly string[]).includes(user.email),
  );

  for (const user of targets) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);

    if (deleteError !== null) {
      throw new Error(`Could not delete ${user.email}: ${deleteError.message}`);
    }
  }
}

/**
 * How many rows the two users still own, per table.
 *
 * Read over the service-role key on purpose — this is the one question RLS
 * cannot answer, because after the users are gone there is no session left to
 * ask it with. The teardown asserts these are all zero, which is what turns
 * "we called delete" into "the cascade actually fired".
 */
export async function countRowsOwnedByTestUsers(userIds: string[]): Promise<Record<string, number>> {
  const admin = adminClient();
  const counts: Record<string, number> = {};

  for (const table of ['layouts', 'missions', 'runs']) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .in('user_id', userIds);

    if (error !== null) throw new Error(`Could not count ${table}: ${error.message}`);

    counts[table] = count ?? 0;
  }

  return counts;
}
