import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { Session } from '../../../src/lib/layout/layout-api';
import { aiGenerationsInLastHour } from '../../../src/lib/missions/mission-api';
import { AI_GENERATIONS_PER_HOUR } from '../../../src/lib/schemas/mission';

/**
 * What the rate limit actually asks the database.
 *
 * There is no `ai_generations` table on purpose — the `missions` rows are the
 * ledger. That only holds if the query really filters to `source = 'ai'` and to
 * the last hour, so this captures the filters rather than trusting them: a
 * missing `.eq('source', 'ai')` would silently let a manual mission burn an AI
 * generation, and nothing in the UI would show it.
 */
type Filter = { column: string; value: unknown };

type Capture = {
  table: string;
  columns: string;
  options: unknown;
  filters: Filter[];
};

function stubSupabase(
  capture: Capture[],
  result: { count: number | null; error: { message: string } | null },
): SupabaseClient {
  const client = {
    from(table: string) {
      return {
        select(columns: string, options: unknown) {
          const entry: Capture = { table, columns, options, filters: [] };
          capture.push(entry);

          const chain = {
            eq(column: string, value: unknown) {
              entry.filters.push({ column, value });
              return chain;
            },
            // `gte` is the terminal call in the query under test, so it
            // resolves rather than returning the chain.
            gte(column: string, value: unknown) {
              entry.filters.push({ column, value });
              return Promise.resolve(result);
            },
          };

          return chain;
        },
      };
    },
  };

  // Not a SupabaseClient — it answers the handful of calls this query makes.
  // CLAUDE.md allows in tests the casts it forbids in src.
  return client as unknown as SupabaseClient;
}

function session(capture: Capture[], result: Parameters<typeof stubSupabase>[1]): Session {
  return {
    supabase: stubSupabase(capture, result),
    user: { id: 'user-from-session' } as unknown as User,
  };
}

describe('aiGenerationsInLastHour', () => {
  it('counts only AI missions, only from the last hour', async () => {
    const capture: Capture[] = [];

    const used = await aiGenerationsInLastHour(session(capture, { count: 7, error: null }));

    expect(used).toBe(7);

    const [query] = capture;
    expect(query.table).toBe('missions');
    // `head: true` asks for the count without dragging the rows back.
    expect(query.options).toEqual({ count: 'exact', head: true });

    const source = query.filters.find((filter) => filter.column === 'source');
    expect(source?.value).toBe('ai');

    const since = query.filters.find((filter) => filter.column === 'created_at');
    expect(typeof since?.value).toBe('string');

    const elapsed = Date.now() - Date.parse(String(since?.value));
    // A one-hour rolling window, allowing for the test's own execution time.
    expect(elapsed).toBeGreaterThan(59 * 60 * 1000);
    expect(elapsed).toBeLessThan(61 * 60 * 1000);
  });

  it('never filters on user_id — the select policy already scopes it', () => {
    // Adding `.eq('user_id', ...)` here would imply RLS were optional, which is
    // the habit CLAUDE.md rule 5 exists to prevent.
    const capture: Capture[] = [];

    void aiGenerationsInLastHour(session(capture, { count: 0, error: null }));

    expect(capture[0].filters.map((filter) => filter.column)).not.toContain('user_id');
  });

  it('treats a null count as zero used', async () => {
    const used = await aiGenerationsInLastHour(session([], { count: null, error: null }));

    expect(used).toBe(0);
  });

  it('reports null on a query error so the endpoint can fail closed', async () => {
    // Not zero: a database error must not read as "plenty of quota left".
    const used = await aiGenerationsInLastHour(
      session([], { count: null, error: { message: 'boom' } }),
    );

    expect(used).toBeNull();
  });

  it('pins the documented limit', () => {
    expect(AI_GENERATIONS_PER_HOUR).toBe(20);
  });
});
