import { describe, expect, it } from 'vitest';

import {
  DEMO_ITEM,
  DEMO_MISSION_NAME,
  FAILING_DEMO_MISSION_NAME,
  buildDemoMission,
  buildFailingDemoMission,
  demoMissionBlocker,
  failingDemoMissionBlocker,
  withDemoStock,
} from '../../../src/lib/fixtures/demo-missions';
import { hasBlockingIssues, simulate, validateMission } from '../../../src/lib/sim';
import type { Layout, Station } from '../../../src/lib/sim';
import { bench, grid } from '../sim/layouts';

/** `bench()` ships a stocked shelf, a dock, and a charger — the happy layout. */
function stocked(): Layout {
  return bench();
}

function withoutKind(kind: Station['kind']): Layout {
  const layout = stocked();

  return { ...layout, stations: layout.stations.filter((station) => station.kind !== kind) };
}

describe('buildDemoMission', () => {
  it('builds a pick-and-place plan from the layout it is given', () => {
    const layout = stocked();
    const demo = buildDemoMission(layout);

    expect(demo).not.toBeNull();
    expect(demo?.name).toBe(DEMO_MISSION_NAME);
    expect(demo?.mission.steps).toEqual([
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      { op: 'MOVE_TO', stationId: 'dock-1' },
      { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
    ]);
  });

  it('produces a plan that validates against the layout', () => {
    const layout = stocked();
    const demo = buildDemoMission(layout);

    if (demo === null) throw new Error('expected a demo mission');

    expect(validateMission(layout, demo.mission)).toEqual([]);
  });

  it('produces a plan that actually succeeds', () => {
    const layout = stocked();
    const demo = buildDemoMission(layout);

    if (demo === null) throw new Error('expected a demo mission');

    const result = simulate(layout, demo.mission, { seed: 0 });

    expect(result.status).toBe('success');
    expect(result.failure).toBeUndefined();
  });

  it('adapts to whichever stations the layout has, without hardcoded ids', () => {
    const layout = grid({
      width: 6,
      height: 6,
      start: { x: 5, y: 5 },
      stations: [
        { id: 'bay', name: 'Bay', cell: { x: 1, y: 4 }, kind: 'dock' },
        { id: 'rack-a', name: 'Rack A', cell: { x: 3, y: 1 }, kind: 'shelf', items: ['widget'] },
      ],
    });

    const demo = buildDemoMission(layout);

    expect(demo?.mission.steps).toEqual([
      { op: 'MOVE_TO', stationId: 'rack-a' },
      { op: 'PICK', stationId: 'rack-a', item: 'widget' },
      { op: 'MOVE_TO', stationId: 'bay' },
      { op: 'PLACE', stationId: 'bay', item: 'widget' },
    ]);
    expect(simulate(layout, demo?.mission ?? { steps: [] }, { seed: 0 }).status).toBe('success');
  });

  it('picks the first stocked shelf, so the same layout always yields the same plan', () => {
    const layout = grid({
      stations: [
        { id: 'empty-shelf', name: 'Empty', cell: { x: 1, y: 0 }, kind: 'shelf' },
        { id: 'full-shelf', name: 'Full', cell: { x: 2, y: 0 }, kind: 'shelf', items: ['cog'] },
        { id: 'dock-1', name: 'Dock', cell: { x: 0, y: 0 }, kind: 'dock' },
      ],
    });

    expect(buildDemoMission(layout)?.mission.steps[0]).toEqual({
      op: 'MOVE_TO',
      stationId: 'full-shelf',
    });
  });

  it('returns null when the layout has no shelf', () => {
    const layout = withoutKind('shelf');

    expect(buildDemoMission(layout)).toBeNull();
    expect(demoMissionBlocker(layout)?.code).toBe('NO_SHELF');
  });

  it('returns null when the layout has no dock', () => {
    const layout = withoutKind('dock');

    expect(buildDemoMission(layout)).toBeNull();
    expect(demoMissionBlocker(layout)?.code).toBe('NO_DOCK');
  });

  it('returns null when no shelf holds an item, because PICK would fail', () => {
    const layout = stocked();
    const bare: Layout = {
      ...layout,
      stations: layout.stations.map((station) => ({ ...station, items: [] })),
    };

    expect(buildDemoMission(bare)).toBeNull();
    expect(demoMissionBlocker(bare)?.code).toBe('NO_STOCKED_SHELF');
  });

  it('reports no blocker once the layout can support the plan', () => {
    expect(demoMissionBlocker(stocked())).toBeNull();
  });
});

describe('buildFailingDemoMission', () => {
  it('drives to a shelf and then tries to charge there', () => {
    const layout = stocked();
    const demo = buildFailingDemoMission(layout);

    expect(demo?.name).toBe(FAILING_DEMO_MISSION_NAME);
    expect(demo?.mission.steps).toEqual([
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'CHARGE', stationId: 'shelf-1', toPercent: 100 },
    ]);
  });

  it('fails deterministically with WRONG_STATION_KIND at the charge step', () => {
    const layout = stocked();
    const demo = buildFailingDemoMission(layout);

    if (demo === null) throw new Error('expected a failing demo mission');

    const first = simulate(layout, demo.mission, { seed: 0 });
    const second = simulate(layout, demo.mission, { seed: 0 });

    expect(first.status).toBe('failed');
    expect(first.failure?.code).toBe('WRONG_STATION_KIND');
    expect(first.failure?.stepIndex).toBe(1);
    expect(second.failure).toEqual(first.failure);
  });

  it('moves before it fails, so playback has something to show', () => {
    const layout = stocked();
    const demo = buildFailingDemoMission(layout);

    if (demo === null) throw new Error('expected a failing demo mission');

    const result = simulate(layout, demo.mission, { seed: 0 });

    expect(result.ticks).toBeGreaterThan(0);
    expect(result.distance).toBeGreaterThan(0);
    expect(result.frames.length).toBeGreaterThan(1);
  });

  it('is flagged by the static validator too — the plan is wrong, not just unlucky', () => {
    const layout = stocked();
    const demo = buildFailingDemoMission(layout);

    if (demo === null) throw new Error('expected a failing demo mission');

    const issues = validateMission(layout, demo.mission);

    expect(hasBlockingIssues(issues)).toBe(true);
    expect(issues.map((issue) => issue.code)).toContain('WRONG_STATION_KIND');
  });

  it('returns null when the layout has no shelf', () => {
    const layout = withoutKind('shelf');

    expect(buildFailingDemoMission(layout)).toBeNull();
    expect(failingDemoMissionBlocker(layout)?.code).toBe('NO_SHELF');
  });

  it('needs no items, so it works on a layout the editor just drew', () => {
    const layout = grid({
      stations: [{ id: 's', name: 'Shelf', cell: { x: 2, y: 2 }, kind: 'shelf' }],
    });

    expect(buildFailingDemoMission(layout)).not.toBeNull();
  });
});

describe('withDemoStock', () => {
  it('adds the demo item to the first shelf and leaves everything else alone', () => {
    const layout = grid({
      obstacles: [{ x: 4, y: 4 }],
      stations: [
        { id: 'dock-1', name: 'Dock', cell: { x: 0, y: 0 }, kind: 'dock' },
        { id: 'shelf-1', name: 'Shelf', cell: { x: 2, y: 0 }, kind: 'shelf' },
      ],
    });

    const stockedLayout = withDemoStock(layout);

    expect(stockedLayout?.stations[1].items).toEqual([DEMO_ITEM]);
    expect(stockedLayout?.stations[0]).toEqual(layout.stations[0]);
    expect(stockedLayout?.obstacles).toEqual(layout.obstacles);
    // Pure: the input is untouched.
    expect(layout.stations[1].items).toBeUndefined();
  });

  it('unblocks the demo mission it exists to unblock', () => {
    const layout = grid({
      stations: [
        { id: 'dock-1', name: 'Dock', cell: { x: 0, y: 0 }, kind: 'dock' },
        { id: 'shelf-1', name: 'Shelf', cell: { x: 2, y: 0 }, kind: 'shelf' },
      ],
    });

    expect(buildDemoMission(layout)).toBeNull();

    const stockedLayout = withDemoStock(layout);

    if (stockedLayout === null) throw new Error('expected a stocked layout');

    expect(buildDemoMission(stockedLayout)).not.toBeNull();
    expect(simulate(stockedLayout, buildDemoMission(stockedLayout)?.mission ?? { steps: [] }, {
      seed: 0,
    }).status).toBe('success');
  });

  it('returns null when a shelf is already stocked, so it is never a no-op write', () => {
    expect(withDemoStock(stocked())).toBeNull();
  });

  it('returns null when there is no shelf to stock', () => {
    expect(withDemoStock(withoutKind('shelf'))).toBeNull();
  });
});
