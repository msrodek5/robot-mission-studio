/**
 * Negative row-level security test — the M2 gate.
 *
 * `.ai/implementation-plan.md` section 10 names silently permissive RLS as the
 * project's most likely security bug, and the reason is that it looks perfect in
 * the UI: you only ever view your own rows, so a policy of `using (true)` is
 * indistinguishable from a correct one until someone else signs up.
 *
 * So this test drives the Data API as two real users over the anon key. The
 * service-role key appears only to create and destroy those users — using it for
 * an assertion would bypass RLS and make the whole file meaningless.
 *
 * Requires a reachable Supabase project. Run with `npm run test:rls`, not
 * `npm test`.
 */

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SUPABASE_URL = requireEnv('PUBLIC_SUPABASE_URL');
const ANON_KEY = requireEnv('PUBLIC_SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const PASSWORD = 'rls-test-password-8f2a';
const EMAIL_A = 'rls-user-a@example.com';
const EMAIL_B = 'rls-user-b@example.com';

/** PostgreSQL `insufficient_privilege` — a `with check` or grant refusal. */
const INSUFFICIENT_PRIVILEGE = '42501';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userA: User;
let userB: User;
let asA: SupabaseClient;
let asB: SupabaseClient;
/** Anon key, no session at all. */
const anonymous = anonClient();

/** One row per table, all owned by user A. */
let ownedIds: { layouts: string; missions: string; runs: string };

beforeAll(async () => {
  await deleteUsersByEmail([EMAIL_A, EMAIL_B]);

  userA = await createConfirmedUser(EMAIL_A);
  userB = await createConfirmedUser(EMAIL_B);

  asA = await signIn(EMAIL_A);
  asB = await signIn(EMAIL_B);

  ownedIds = await seedRowsOwnedByA();
});

afterAll(async () => {
  // `on delete cascade` from auth.users takes the seeded rows with it, so the
  // suite leaves nothing behind and can be re-run immediately.
  await deleteUsersByEmail([EMAIL_A, EMAIL_B]);
});

// ---------------------------------------------------------------------------
// Positive control — must come first
// ---------------------------------------------------------------------------

// Without this, every "expect zero rows" assertion below would also pass if the
// tables were missing or the `authenticated` grants were never applied. That is
// a false green on the one test the milestone exists to produce.
describe('positive control: the owner can reach their own rows', () => {
  it('the two clients are authenticated as different users', async () => {
    // Also load-bearing. If B's sign-in had silently failed, B would be
    // anonymous and every "zero rows" assertion below would pass for the wrong
    // reason — no session rather than a working policy.
    const [a, b] = await Promise.all([asA.auth.getUser(), asB.auth.getUser()]);

    expect(a.data.user?.id).toBe(userA.id);
    expect(b.data.user?.id).toBe(userB.id);
    expect(userA.id).not.toBe(userB.id);
  });

  it.each(['layouts', 'missions', 'runs'] as const)('user A reads their %s row', async (table) => {
    const { data, error } = await asA.from(table).select('id').eq('id', ownedIds[table]);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it.each(['layouts', 'missions', 'runs'] as const)(
    'user A sees exactly one %s row in an unfiltered read',
    async (table) => {
      const { data, error } = await asA.from(table).select('id');

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// The negative cases
// ---------------------------------------------------------------------------

type TableCase = {
  table: 'layouts' | 'missions' | 'runs';
  /** A column B will try to overwrite, and the value A must still see after. */
  probeColumn: string;
  originalValue: string | number;
  tamperedValue: string | number;
  /** A row B will try to insert while claiming A owns it. */
  forgedRow: () => Record<string, unknown>;
};

const CASES: TableCase[] = [
  {
    table: 'layouts',
    probeColumn: 'name',
    originalValue: 'A owned layout',
    tamperedValue: 'B was here',
    forgedRow: () => ({
      user_id: userA.id,
      name: 'forged by B',
      width: 10,
      height: 10,
      grid: {},
    }),
  },
  {
    table: 'missions',
    probeColumn: 'name',
    originalValue: 'A owned mission',
    tamperedValue: 'B was here',
    forgedRow: () => ({
      user_id: userA.id,
      layout_id: ownedIds.layouts,
      name: 'forged by B',
      plan: { steps: [] },
      source: 'manual',
    }),
  },
  {
    table: 'runs',
    probeColumn: 'ticks',
    originalValue: 12,
    tamperedValue: 9999,
    forgedRow: () => ({
      user_id: userA.id,
      mission_id: ownedIds.missions,
      seed: 0,
      status: 'success',
      ticks: 1,
      distance: 1,
      battery_end: 99,
      log: [],
    }),
  },
];

describe.each(CASES)('$table is invisible to a non-owner', (testCase) => {
  const { table, probeColumn, originalValue, tamperedValue } = testCase;

  it('a targeted read by id returns an empty set, not an error', async () => {
    const { data, error } = await asB.from(table).select('*').eq('id', ownedIds[table]);

    // This is the exact shape of the bug being guarded against. PostgREST
    // filters by policy rather than rejecting, so a permissive policy shows up
    // as a populated array here and nowhere else.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an unfiltered read returns nothing', async () => {
    const { data, error } = await asB.from(table).select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an update changes no rows and leaves the original intact', async () => {
    const { data, error } = await asB
      .from(table)
      .update({ [probeColumn]: tamperedValue })
      .eq('id', ownedIds[table])
      .select();

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    // Checking the returned rows alone is not enough: a policy could permit the
    // write while hiding the result. Read it back as the owner.
    const { data: owner } = await asA
      .from(table)
      .select(probeColumn)
      .eq('id', ownedIds[table])
      .single();

    expect(owner).toMatchObject({ [probeColumn]: originalValue });
  });

  it('a delete removes no rows and the original survives', async () => {
    const { data, error } = await asB
      .from(table)
      .delete()
      .eq('id', ownedIds[table])
      .select();

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: owner, error: ownerError } = await asA
      .from(table)
      .select('id')
      .eq('id', ownedIds[table])
      .single();

    expect(ownerError).toBeNull();
    expect(owner).toMatchObject({ id: ownedIds[table] });
  });

  it('an insert claiming another user as owner is rejected', async () => {
    const { data, error } = await asB.from(table).insert(testCase.forgedRow()).select();

    // `with check (user_id = auth.uid())` fires here. Unlike select, a blocked
    // insert is a hard error rather than a silent no-op.
    expect(error).not.toBeNull();
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(data).toBeNull();
  });

  it('an anonymous read is refused at the privilege level, not merely filtered', async () => {
    const { data, error } = await anonymous.from(table).select('*');

    expect(data ?? []).toHaveLength(0);

    // Demanding an error rather than an empty set is the point. `anon` holds no
    // grant, so the request dies before RLS is consulted — if this ever starts
    // returning `[]` instead, the grant is back and RLS has quietly become the
    // only thing standing in front of the table.
    expect(error).not.toBeNull();
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name} is not set. The RLS test needs a live Supabase project: fill it in .env. ` +
        'SUPABASE_SERVICE_ROLE_KEY is used only to create and delete the two test users.',
    );
  }

  return value;
}

function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Created through the admin API with the email pre-confirmed. A plain `signUp`
 * would return no session on a project that has email confirmation switched on,
 * leaving the test unable to authenticate.
 */
async function createConfirmedUser(email: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`Could not create ${email}: ${error?.message ?? 'no user returned'}`);
  }

  return data.user;
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });

  if (error) throw new Error(`Could not sign in ${email}: ${error.message}`);

  return client;
}

/** Removes leftovers from an interrupted run so the suite is re-runnable. */
async function deleteUsersByEmail(emails: string[]): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

  if (error) throw new Error(`Could not list users: ${error.message}`);

  const targets = data.users.filter((user) => user.email && emails.includes(user.email));

  for (const user of targets) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);

    if (deleteError) throw new Error(`Could not delete ${user.email}: ${deleteError.message}`);
  }
}

/**
 * Seeds one row per table as user A, over the anon key. Doing this through A's
 * own session rather than the admin client means the insert policies and the
 * `authenticated` grants are exercised before any assertion runs.
 */
async function seedRowsOwnedByA(): Promise<{ layouts: string; missions: string; runs: string }> {
  const layoutId = await insertAs(asA, 'layouts', {
    user_id: userA.id,
    name: 'A owned layout',
    width: 10,
    height: 10,
    grid: { obstacles: [], stations: [], start: { x: 0, y: 0 } },
  });

  const missionId = await insertAs(asA, 'missions', {
    user_id: userA.id,
    layout_id: layoutId,
    name: 'A owned mission',
    brief: 'move to the dock',
    plan: { steps: [] },
    source: 'manual',
  });

  const runId = await insertAs(asA, 'runs', {
    user_id: userA.id,
    mission_id: missionId,
    seed: 0,
    status: 'success',
    ticks: 12,
    distance: 8,
    battery_end: 94,
    log: [],
  });

  return { layouts: layoutId, missions: missionId, runs: runId };
}

async function insertAs(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await client.from(table).insert(row).select('id').single();

  if (error) {
    // `permission denied for table ...` here means the grants in the migration
    // did not apply, not that a policy is wrong.
    throw new Error(`Seeding ${table} failed: ${error.message} (${error.code})`);
  }

  return String(data.id);
}
