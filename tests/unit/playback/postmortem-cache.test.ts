import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { Session } from '../../../src/lib/layout/layout-api';
import {
  RUN_COLUMNS,
  RUN_DETAIL_COLUMNS,
  parseRunRow,
  savePostmortem,
  toPostmortemRecord,
} from '../../../src/lib/runs/run-api';
import {
  CHANGE_MAX_CHARS,
  DIAGNOSIS_MAX_CHARS,
  MAX_SUGGESTED_EDITS,
  PostmortemSchema,
  RunDetailSchema,
  RunRecordSchema,
} from '../../../src/lib/schemas/mission';
import type { PostmortemRecord } from '../../../src/lib/schemas/mission';

const RECORD: PostmortemRecord = {
  diagnosis: 'The gripper was already holding the bolt when the plan asked for a second pick.',
  suggestedEdits: [{ stepIndex: 2, change: 'Place the bolt at Dock before picking again.' }],
  model: 'claude-haiku-4-5',
  promptVersion: 'postmortem-v1',
  createdAt: '2026-09-10T18:00:00.000Z',
};

/** A run row as PostgREST sends it. `postmortem` is the field under test. */
function runRow(postmortem?: unknown) {
  const row: Record<string, unknown> = {
    id: 'run-1',
    mission_id: 'mission-1',
    seed: 0,
    status: 'failed',
    ticks: 7,
    distance: '4',
    battery_end: '96',
    failure: { stepIndex: 2, code: 'GRIPPER_FULL', detail: 'full' },
    log: [],
    created_at: '2026-09-10T17:00:00.000Z',
  };

  if (postmortem !== undefined) row.postmortem = postmortem;

  return row;
}

describe('PostmortemSchema', () => {
  it('accepts a normal postmortem', () => {
    expect(PostmortemSchema.safeParse(RECORD).success).toBe(true);
  });

  it('accepts an empty edit list', () => {
    // Some failures have no step-level fix. Requiring one would buy an invention.
    const parsed = PostmortemSchema.safeParse({ diagnosis: 'walled off', suggestedEdits: [] });

    expect(parsed.success).toBe(true);
  });

  it('rejects a missing or empty diagnosis', () => {
    expect(PostmortemSchema.safeParse({ suggestedEdits: [] }).success).toBe(false);
    expect(PostmortemSchema.safeParse({ diagnosis: '', suggestedEdits: [] }).success).toBe(false);
    expect(PostmortemSchema.safeParse({ diagnosis: '   ', suggestedEdits: [] }).success).toBe(false);
  });

  it(`rejects a diagnosis over ${DIAGNOSIS_MAX_CHARS} characters`, () => {
    const long = { diagnosis: 'x'.repeat(DIAGNOSIS_MAX_CHARS + 1), suggestedEdits: [] };

    expect(PostmortemSchema.safeParse(long).success).toBe(false);
    expect(
      PostmortemSchema.safeParse({ diagnosis: 'x'.repeat(DIAGNOSIS_MAX_CHARS), suggestedEdits: [] })
        .success,
    ).toBe(true);
  });

  it(`rejects more than ${MAX_SUGGESTED_EDITS} edits`, () => {
    const edits = (count: number) =>
      Array.from({ length: count }, (_edit, index) => ({ stepIndex: index, change: 'x' }));

    expect(
      PostmortemSchema.safeParse({ diagnosis: 'd', suggestedEdits: edits(MAX_SUGGESTED_EDITS) })
        .success,
    ).toBe(true);
    expect(
      PostmortemSchema.safeParse({ diagnosis: 'd', suggestedEdits: edits(MAX_SUGGESTED_EDITS + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects an edit with no change, an over-long change, or a bad index', () => {
    const with_ = (edit: unknown) => PostmortemSchema.safeParse({ diagnosis: 'd', suggestedEdits: [edit] });

    expect(with_({ stepIndex: 0, change: '' }).success).toBe(false);
    expect(with_({ stepIndex: 0, change: 'x'.repeat(CHANGE_MAX_CHARS + 1) }).success).toBe(false);
    expect(with_({ stepIndex: -1, change: 'x' }).success).toBe(false);
    expect(with_({ stepIndex: 1.5, change: 'x' }).success).toBe(false);
    expect(with_({ stepIndex: 'two', change: 'x' }).success).toBe(false);
    // No anchor is the whole thing US-6 rules out.
    expect(with_({ change: 'charge more often' }).success).toBe(false);
  });
});

describe('the run record stays lean', () => {
  it('has no postmortem field, so the history list does not ship one per row', () => {
    const parsed = RunRecordSchema.parse({ ...toRunRecordInput(), postmortem: RECORD });

    expect('postmortem' in parsed).toBe(false);
  });

  it('is selected by the narrow column list, while the detail read adds the column', () => {
    expect(RUN_COLUMNS).not.toContain('postmortem');
    expect(RUN_DETAIL_COLUMNS).toContain('postmortem');
    // The detail set is the narrow set plus one column, not a second hand-kept
    // list that could drift from it.
    expect(RUN_DETAIL_COLUMNS.startsWith(RUN_COLUMNS)).toBe(true);
  });
});

function toRunRecordInput() {
  return {
    id: 'run-1',
    missionId: 'mission-1',
    seed: 0,
    status: 'failed' as const,
    ticks: 7,
    distance: 4,
    batteryEnd: 96,
    failure: { stepIndex: 2, code: 'GRIPPER_FULL' as const, detail: 'full' },
    log: [],
    createdAt: '2026-09-10T17:00:00.000Z',
  };
}

describe('RunDetailSchema', () => {
  const base = {
    run: toRunRecordInput(),
    mission: {
      id: 'mission-1',
      layoutId: 'layout-1',
      name: 'Fetch a bolt',
      source: 'ai' as const,
      plan: { steps: [] },
      createdAt: '2026-09-10T16:00:00.000Z',
    },
    layout: { width: 5, height: 5, obstacles: [], stations: [], start: { x: 0, y: 0 } },
    layoutId: 'layout-1',
    layoutName: 'Warehouse',
  };

  it('requires the postmortem field, nullable', () => {
    expect(RunDetailSchema.safeParse({ ...base, postmortem: null }).success).toBe(true);
    expect(RunDetailSchema.safeParse({ ...base, postmortem: RECORD }).success).toBe(true);
    // Absent is not the same as null: playback reads this field, so a response
    // that forgot it should fail loudly here rather than render as "no cache".
    expect(RunDetailSchema.safeParse(base).success).toBe(false);
  });

  it('keeps the provenance fields the record carries', () => {
    const parsed = RunDetailSchema.parse({ ...base, postmortem: RECORD });

    expect(parsed.postmortem?.model).toBe('claude-haiku-4-5');
    expect(parsed.postmortem?.promptVersion).toBe('postmortem-v1');
  });
});

describe('toPostmortemRecord', () => {
  it('reads a stored postmortem back', () => {
    expect(toPostmortemRecord(parseRunRow(runRow(RECORD)))).toEqual(RECORD);
  });

  it('is null when the column was not selected', () => {
    // A `RUN_COLUMNS` select has no `postmortem` key at all. That has to read as
    // "not cached", not throw.
    expect(toPostmortemRecord(parseRunRow(runRow()))).toBeNull();
  });

  it('is null when the run has no postmortem yet', () => {
    expect(toPostmortemRecord(parseRunRow(runRow(null)))).toBeNull();
  });

  it('is null when the stored blob no longer parses', () => {
    // A row written by an older PROMPT_VERSION should leave the run page loadable
    // with the Explain button, not blank the screen.
    expect(toPostmortemRecord(parseRunRow(runRow({ diagnosis: 'no edits key' })))).toBeNull();
    expect(toPostmortemRecord(parseRunRow(runRow('not an object')))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

type Capture = {
  table: string;
  payload: unknown;
  filters: Array<{ method: string; column: string; value: unknown }>;
  columns: string;
};

/**
 * What the write actually asks the database.
 *
 * The `.is('postmortem', null)` filter is the only thing standing between two
 * concurrent requests and a diagnosis that changes under the user, so it is
 * captured and asserted rather than trusted to survive the next edit.
 */
function stubSupabase(capture: Capture[], result: { data: unknown; error: { message: string } | null }) {
  const client = {
    from(table: string) {
      return {
        update(payload: unknown) {
          const entry: Capture = { table, payload, filters: [], columns: '' };
          capture.push(entry);

          const chain = {
            eq(column: string, value: unknown) {
              entry.filters.push({ method: 'eq', column, value });
              return chain;
            },
            is(column: string, value: unknown) {
              entry.filters.push({ method: 'is', column, value });
              return chain;
            },
            select(columns: string) {
              entry.columns = columns;
              return { maybeSingle: () => Promise.resolve(result) };
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

describe('savePostmortem', () => {
  it('writes only onto a run that has no postmortem yet', async () => {
    const capture: Capture[] = [];

    const saved = await savePostmortem(session(capture, { data: runRow(RECORD), error: null }), 'run-1', RECORD);

    expect(saved).toEqual({ postmortem: RECORD });

    const [query] = capture;
    expect(query.table).toBe('runs');
    expect(query.payload).toEqual({ postmortem: RECORD });

    // The guard: without this filter two tabs both call the model and the second
    // write overwrites the first.
    expect(query.filters).toEqual([
      { method: 'eq', column: 'id', value: 'run-1' },
      { method: 'is', column: 'postmortem', value: null },
    ]);
    expect(query.columns).toBe(RUN_DETAIL_COLUMNS);
  });

  it('never filters on user_id — the update policy already scopes it', () => {
    // Adding `.eq('user_id', ...)` here would imply RLS were optional, which is
    // the habit CLAUDE.md rule 5 exists to prevent.
    const capture: Capture[] = [];

    void savePostmortem(session(capture, { data: runRow(RECORD), error: null }), 'run-1', RECORD);

    expect(capture[0].filters.map((filter) => filter.column)).not.toContain('user_id');
  });

  it('returns null when no row matched, so the caller can re-read the winner', async () => {
    const saved = await savePostmortem(session([], { data: null, error: null }), 'run-1', RECORD);

    // Not an error: this is the losing side of a race, or a run that stopped
    // being visible. Both have a correct answer that is not a 500.
    expect(saved).toBeNull();
  });

  it('surfaces a database error rather than pretending it was a race', async () => {
    const saved = await savePostmortem(
      session([], { data: null, error: { message: 'boom' } }),
      'run-1',
      RECORD,
    );

    expect(saved).not.toBeNull();
    expect(saved !== null && 'error' in saved).toBe(true);
  });
});
