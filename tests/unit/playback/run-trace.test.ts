import { describe, expect, it } from 'vitest';

import { compareRun, traceUpTo } from '../../../src/components/playback/run-trace';
import type { RunDetail } from '../../../src/lib/schemas/mission';
import { cellKey, simulate, stripFrames } from '../../../src/lib/sim';
import type { Frame, RunResult } from '../../../src/lib/sim';
import { runFixtures } from './run-fixtures';

function frame(tick: number, x: number, y: number, battery = 100): Frame {
  return { tick, stepIndex: 0, pos: { x, y }, battery, carrying: null };
}

/** A `RunDetail` whose run row is exactly what `simulate()` just produced. */
function detailFor(result: RunResult, overrides: Partial<RunDetail['run']> = {}): RunDetail {
  const persisted = stripFrames(result);

  return {
    run: {
      id: 'run-1',
      missionId: 'mission-1',
      seed: 0,
      status: persisted.status,
      ticks: persisted.ticks,
      distance: persisted.distance,
      batteryEnd: persisted.batteryEnd,
      failure: persisted.failure ?? null,
      log: persisted.log,
      createdAt: '2026-08-27T20:00:00+00:00',
      ...overrides,
    },
    mission: {
      id: 'mission-1',
      layoutId: 'layout-1',
      name: 'Demo',
      source: 'manual',
      plan: { steps: [] },
      createdAt: '2026-08-27T20:00:00+00:00',
    },
    layout: { width: 5, height: 5, obstacles: [], stations: [], start: { x: 0, y: 0 } },
    layoutId: 'layout-1',
    layoutName: 'Layout',
    // The determinism check is about the run row, not the postmortem — these
    // fixtures never carry one.
    postmortem: null,
  };
}

describe('traceUpTo', () => {
  it('shades every cell up to the current frame and no further', () => {
    const frames = [frame(0, 0, 0), frame(1, 1, 0), frame(2, 2, 0), frame(3, 3, 0)];
    const trace = traceUpTo(frames, 2);

    expect([...trace.visited].sort()).toEqual(['0,0', '1,0', '2,0']);
    expect(trace.visited.has(cellKey({ x: 3, y: 0 }))).toBe(false);
  });

  it('counts one cell of distance per position change', () => {
    const frames = [frame(0, 0, 0), frame(1, 1, 0), frame(2, 2, 0)];

    expect(traceUpTo(frames, 2).distance).toBe(2);
  });

  it('does not count ticks the robot spent standing still', () => {
    // PICK, PLACE, WAIT, and CHARGE all advance the tick without moving.
    const frames = [frame(0, 0, 0), frame(1, 1, 0), frame(2, 1, 0), frame(3, 1, 0)];

    expect(traceUpTo(frames, 3).distance).toBe(1);
    expect(traceUpTo(frames, 3).visited.size).toBe(2);
  });

  it('counts a revisited cell once but still counts the travel', () => {
    // There and back: two moves, one new cell.
    const frames = [frame(0, 0, 0), frame(1, 1, 0), frame(2, 0, 0)];
    const trace = traceUpTo(frames, 2);

    expect(trace.visited.size).toBe(2);
    expect(trace.distance).toBe(2);
  });

  it('handles frame 0 and an out-of-range index without throwing', () => {
    const frames = [frame(0, 2, 2)];

    expect(traceUpTo(frames, 0)).toEqual({ visited: new Set(['2,2']), distance: 0 });
    expect(traceUpTo(frames, 99).distance).toBe(0);
    expect(traceUpTo([], 0)).toEqual({ visited: new Set(), distance: 0 });
  });

  it('agrees with the simulator on total distance at the final frame', () => {
    for (const fixture of runFixtures()) {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);
      const trace = traceUpTo(result.frames, result.frames.length - 1);

      // The panel shows this number next to the persisted one, so a mismatch
      // would read as a bug in the run rather than in the counting.
      expect(trace.distance).toBe(result.distance);
    }
  });
});

describe('compareRun', () => {
  it('finds nothing to report when the browser reproduces the run', () => {
    for (const fixture of runFixtures()) {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);

      expect(compareRun(detailFor(result), result)).toEqual([]);
    }
  });

  it('reports a status divergence', () => {
    const [fixture] = runFixtures();
    const result = simulate(fixture.layout, fixture.mission, fixture.opts);

    const divergences = compareRun(
      detailFor(result, { status: 'failed', failure: { stepIndex: 0, code: 'UNREACHABLE', detail: 'x' } }),
      result,
    );

    expect(divergences.map((d) => d.field)).toContain('status');
    expect(divergences.map((d) => d.field)).toContain('failure.code');
  });

  it('reports a tick divergence with both numbers', () => {
    const [fixture] = runFixtures();
    const result = simulate(fixture.layout, fixture.mission, fixture.opts);

    const [divergence] = compareRun(detailFor(result, { ticks: result.ticks + 1 }), result);

    expect(divergence).toEqual({
      field: 'ticks',
      persisted: String(result.ticks + 1),
      recomputed: String(result.ticks),
    });
  });

  it('reports distance and battery divergences', () => {
    const [fixture] = runFixtures();
    const result = simulate(fixture.layout, fixture.mission, fixture.opts);

    const fields = compareRun(
      detailFor(result, { distance: result.distance + 2, batteryEnd: result.batteryEnd - 5 }),
      result,
    ).map((d) => d.field);

    expect(fields).toEqual(['distance', 'batteryEnd']);
  });

  it('reports a failing step that moved, even when the code matches', () => {
    const fixture = runFixtures()[0];
    const failing = simulate(
      fixture.layout,
      { steps: [{ op: 'CHARGE', stationId: 'shelf-1', toPercent: 100 }] },
      { seed: 0 },
    );

    expect(failing.failure?.code).toBe('WRONG_STATION_KIND');

    const divergences = compareRun(
      detailFor(failing, {
        failure: { stepIndex: 3, code: 'WRONG_STATION_KIND', detail: 'moved' },
      }),
      failing,
    );

    expect(divergences.map((d) => d.field)).toEqual(['failure.stepIndex']);
  });

  it('tolerates numeric round-trip dust but not a real difference', () => {
    const [fixture] = runFixtures();
    const result = simulate(fixture.layout, fixture.mission, fixture.opts);

    // What a `numeric` column can do to a value on the way back.
    expect(compareRun(detailFor(result, { distance: result.distance + 1e-9 }), result)).toEqual([]);
    // A tenth of a cell is not dust; the simulator only ever produces integers.
    expect(
      compareRun(detailFor(result, { distance: result.distance + 0.1 }), result).map((d) => d.field),
    ).toEqual(['distance']);
  });

  it('notices a success persisted for a run that now fails', () => {
    const layout = runFixtures()[0].layout;
    const nowFails = simulate(layout, { steps: [{ op: 'PICK', stationId: 'shelf-1', item: 'ghost' }] }, { seed: 0 });

    const divergences = compareRun(
      detailFor(nowFails, { status: 'success', failure: null }),
      nowFails,
    );

    expect(divergences.map((d) => d.field)).toEqual(['status', 'failure.code', 'failure.stepIndex']);
  });
});
