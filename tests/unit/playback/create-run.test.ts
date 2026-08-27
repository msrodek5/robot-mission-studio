import { describe, expect, it } from 'vitest';

import type { SupabaseClient, User } from '@supabase/supabase-js';

import { buildDemoMission, buildFailingDemoMission } from '../../../src/lib/fixtures/demo-missions';
import { canonicalPlan, createRun, sameMission } from '../../../src/lib/runs/run-api';
import type { Session } from '../../../src/lib/layout/layout-api';
import type { MissionRecord } from '../../../src/lib/schemas/mission';
import { bench } from '../sim/layouts';

/**
 * What actually reaches the `runs` insert.
 *
 * Frames are never persisted (CLAUDE.md rule 6), and the only way to be sure is
 * to look at the payload rather than at the code that builds it. This stubs
 * PostgREST's builder chain, captures the insert, and asserts on it.
 */
type Captured = { table: string; payload: Record<string, unknown> };

function stubSupabase(captured: Captured[], row: Record<string, unknown>): SupabaseClient {
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          captured.push({ table, payload });

          return {
            select() {
              return {
                single: async () => ({ data: { ...row, ...idFrom(payload) }, error: null }),
              };
            },
          };
        },
      };
    },
  };

  // A hand-rolled stand-in for one method of a large client. `as unknown as` is
  // the honest spelling: this is not a SupabaseClient, it just answers the two
  // calls `createRun` makes. Casts like this are why CLAUDE.md allows in tests
  // what it forbids in src.
  return client as unknown as SupabaseClient;
}

function idFrom(payload: Record<string, unknown>): Record<string, unknown> {
  return { mission_id: payload.mission_id, seed: payload.seed };
}

function session(captured: Captured[], row: Record<string, unknown>): Session {
  return {
    supabase: stubSupabase(captured, row),
    user: { id: 'user-from-session' } as unknown as User,
  };
}

const RUN_ROW = {
  id: 'run-1',
  mission_id: 'mission-1',
  seed: 0,
  status: 'success',
  ticks: 8,
  distance: 4,
  battery_end: 96,
  failure: null,
  log: [],
  created_at: '2026-08-27T20:00:00+00:00',
};

function missionRecord(plan: MissionRecord['plan']): MissionRecord {
  return {
    id: 'mission-1',
    layoutId: 'layout-1',
    name: 'Demo',
    source: 'manual',
    plan,
    createdAt: '2026-08-27T20:00:00+00:00',
  };
}

describe('createRun', () => {
  it('never puts frames in the insert payload', async () => {
    const layout = bench();
    const demo = buildDemoMission(layout);

    if (demo === null) throw new Error('expected a demo mission');

    const captured: Captured[] = [];

    await createRun(session(captured, RUN_ROW), {
      mission: missionRecord(demo.mission),
      layout,
      seed: 0,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].table).toBe('runs');
    expect('frames' in captured[0].payload).toBe(false);
    expect(Object.keys(captured[0].payload).sort()).toEqual([
      'battery_end',
      'distance',
      'failure',
      'log',
      'mission_id',
      'seed',
      'status',
      'ticks',
      'user_id',
    ]);
  });

  it('takes user_id from the session, never from the mission or the caller', async () => {
    const layout = bench();
    const demo = buildDemoMission(layout);

    if (demo === null) throw new Error('expected a demo mission');

    const captured: Captured[] = [];

    await createRun(session(captured, RUN_ROW), {
      mission: missionRecord(demo.mission),
      layout,
      seed: 0,
    });

    expect(captured[0].payload.user_id).toBe('user-from-session');
  });

  it('persists the simulated outcome, not a client-supplied one', async () => {
    const layout = bench();
    const failing = buildFailingDemoMission(layout);

    if (failing === null) throw new Error('expected a failing demo mission');

    const captured: Captured[] = [];

    await createRun(
      session(captured, { ...RUN_ROW, status: 'failed', failure: { stepIndex: 1, code: 'WRONG_STATION_KIND', detail: 'x' } }),
      { mission: missionRecord(failing.mission), layout, seed: 3 },
    );

    expect(captured[0].payload.status).toBe('failed');
    expect(captured[0].payload.failure).toMatchObject({
      stepIndex: 1,
      code: 'WRONG_STATION_KIND',
    });
    expect(captured[0].payload.seed).toBe(3);
  });
});

describe('mission reuse', () => {
  it('treats identical plans as the same mission regardless of key order', () => {
    const layout = bench();
    const demo = buildDemoMission(layout);

    if (demo === null) throw new Error('expected a demo mission');

    // What a jsonb round trip can do to key order, done deliberately.
    const reordered = {
      steps: demo.mission.steps.map((step) =>
        step.op === 'PICK' ? { item: step.item, stationId: step.stationId, op: step.op } : step,
      ),
    };

    expect(sameMission(demo.mission, reordered)).toBe(true);
  });

  it('tells different plans apart', () => {
    const layout = bench();
    const demo = buildDemoMission(layout);
    const failing = buildFailingDemoMission(layout);

    if (demo === null || failing === null) throw new Error('expected both demo missions');

    expect(sameMission(demo.mission, failing.mission)).toBe(false);
  });

  it('canonicalises every op, so no step kind silently compares equal', () => {
    expect(
      canonicalPlan({
        steps: [
          { op: 'MOVE_TO', stationId: 'a' },
          { op: 'PICK', stationId: 'a', item: 'x' },
          { op: 'PLACE', stationId: 'b', item: 'x' },
          { op: 'WAIT', ticks: 2 },
          { op: 'CHARGE', stationId: 'c', toPercent: 80 },
        ],
      }),
    ).toBe('[["MOVE_TO","a"],["PICK","a","x"],["PLACE","b","x"],["WAIT",2],["CHARGE","c",80]]');
  });
});
