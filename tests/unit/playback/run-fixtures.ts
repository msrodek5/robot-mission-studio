/**
 * Fixture runs shared by the determinism and frame-invariant tests.
 *
 * Three layouts, chosen so the set covers what playback has to survive: an open
 * grid, a grid where the path has to detour around obstacles, and a run that
 * charges — the only case where battery goes back up, which is the exception the
 * invariant test has to allow for.
 */

import { buildDemoMission } from '../../../src/lib/fixtures/demo-missions';
import type { Layout, Mission, SimOptions } from '../../../src/lib/sim';
import { bench, cells, grid } from '../sim/layouts';

export type RunFixture = {
  name: string;
  layout: Layout;
  mission: Mission;
  opts: SimOptions;
  /** True when the plan contains a CHARGE step, so battery may rise. */
  charges: boolean;
};

/**
 * A wall at x=3 with a gap in the bottom two rows, so every trip from the start
 * to the shelf has to go around. Straight-line pathfinding would pass the
 * adjacency invariant while being wrong, which is exactly what obstacles catch.
 */
function walled(): Layout {
  return grid({
    width: 8,
    height: 8,
    start: { x: 0, y: 0 },
    obstacles: cells([3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5]),
    stations: [
      { id: 'dock-1', name: 'Dock', cell: { x: 7, y: 7 }, kind: 'dock' },
      { id: 'shelf-1', name: 'Shelf', cell: { x: 7, y: 0 }, kind: 'shelf', items: ['crate'] },
      { id: 'charger-1', name: 'Charger', cell: { x: 0, y: 7 }, kind: 'charger' },
    ],
  });
}

function demoOn(layout: Layout): Mission {
  const demo = buildDemoMission(layout);

  // A fixture that silently degraded to an empty plan would make every
  // assertion below vacuously true.
  if (demo === null) throw new Error('fixture layout cannot support the demo mission');

  return demo.mission;
}

/**
 * Pick, top up, then deliver — starting at 30% so the charger is not optional.
 * This is the fixture that makes the battery invariant say something.
 */
function chargingMission(): Mission {
  return {
    steps: [
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      { op: 'MOVE_TO', stationId: 'charger-1' },
      { op: 'CHARGE', stationId: 'charger-1', toPercent: 100 },
      { op: 'MOVE_TO', stationId: 'dock-1' },
      { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
    ],
  };
}

export function runFixtures(): RunFixture[] {
  return [
    {
      name: 'open bench',
      layout: bench(),
      mission: demoOn(bench()),
      opts: { seed: 0 },
      charges: false,
    },
    {
      name: 'walled grid with a detour',
      layout: walled(),
      mission: demoOn(walled()),
      opts: { seed: 7 },
      charges: false,
    },
    {
      name: 'charge mid-mission',
      layout: bench(),
      mission: chargingMission(),
      opts: { seed: 0, batteryStart: 30 },
      charges: true,
    },
  ];
}
