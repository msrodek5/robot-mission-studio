/**
 * Hardcoded demo missions — the M4 stand-in for the planner.
 *
 * These exist so running and playing back a mission can ship before the LLM
 * does. They are pure builders over whatever stations a layout actually has:
 * no fixed coordinates, no assumed station ids, no I/O. Given the same layout
 * they always produce the same plan, which is what makes them usable as test
 * fixtures as well as demo buttons.
 *
 * When the planner lands in M5 these stay: a deterministic mission is the
 * baseline every LLM-generated plan gets compared against.
 */

import type { Layout, Mission, Station } from '../sim';

/** Why a builder could not produce a plan, in words the UI can show verbatim. */
export type DemoUnavailable = {
  code: 'NO_SHELF' | 'NO_DOCK' | 'NO_STOCKED_SHELF';
  message: string;
};

export type DemoMission = {
  /** Stable name, used to find and reuse an identical `missions` row. */
  name: string;
  mission: Mission;
};

export const DEMO_MISSION_NAME = 'Demo — pick and place';
export const FAILING_DEMO_MISSION_NAME = 'Demo — charge at a shelf (fails)';

/**
 * A plan that should succeed: walk to a stocked shelf, pick an item, walk to a
 * dock, put it down.
 *
 * `null` when the layout cannot support it. Note the third reason: PICK fails
 * with `ITEM_NOT_PRESENT` against an empty shelf, so "has a shelf" is not
 * enough — the shelf has to be holding something. The M3 editor never writes
 * `station.items`, so on a freshly drawn layout this is the reason you get.
 *
 * The explicit MOVE_TO steps are redundant — `simulate()` walks to a station
 * before PICK and PLACE anyway — but they make the step list read like the plan
 * a person would write, and playback is a step list the user watches.
 */
export function buildDemoMission(layout: Layout): DemoMission | null {
  const shelf = firstStockedShelf(layout);
  if (shelf === undefined) return null;

  const dock = firstOfKind(layout, 'dock');
  if (dock === undefined) return null;

  const item = stockOf(shelf)[0];

  return {
    name: DEMO_MISSION_NAME,
    mission: {
      steps: [
        { op: 'MOVE_TO', stationId: shelf.id },
        { op: 'PICK', stationId: shelf.id, item },
        { op: 'MOVE_TO', stationId: dock.id },
        { op: 'PLACE', stationId: dock.id, item },
      ],
    },
  };
}

/**
 * A plan that fails deterministically: drive to a shelf, then try to charge
 * there. `CHARGE` only accepts a charger, so the run ends in
 * `WRONG_STATION_KIND` at step 1 — every time, on any layout with a shelf.
 *
 * The leading MOVE_TO is not decoration. `simulate()` rejects the station kind
 * before it spends a tick travelling, so without it the run would be one frame
 * long and playback would have nothing to show before the red banner.
 */
export function buildFailingDemoMission(layout: Layout): DemoMission | null {
  const shelf = firstOfKind(layout, 'shelf');
  if (shelf === undefined) return null;

  return {
    name: FAILING_DEMO_MISSION_NAME,
    mission: {
      steps: [
        { op: 'MOVE_TO', stationId: shelf.id },
        { op: 'CHARGE', stationId: shelf.id, toPercent: 100 },
      ],
    },
  };
}

/**
 * What is missing, for the button's tooltip.
 *
 * Separate from the builders rather than baked into their return type: a
 * builder that returns `Mission | null` is the simpler thing to test and the
 * simpler thing to call, and only the UI needs the prose.
 */
export function demoMissionBlocker(layout: Layout): DemoUnavailable | null {
  if (buildDemoMission(layout) !== null) return null;

  if (firstOfKind(layout, 'shelf') === undefined) {
    return {
      code: 'NO_SHELF',
      message: 'This layout has no shelf to pick from. Add one in the station table.',
    };
  }

  if (firstOfKind(layout, 'dock') === undefined) {
    return {
      code: 'NO_DOCK',
      message: 'This layout has no dock to place at. Add one in the station table.',
    };
  }

  return {
    code: 'NO_STOCKED_SHELF',
    message:
      'No shelf is holding an item, so the pick would fail with ITEM_NOT_PRESENT. ' +
      'Stock a shelf to run this demo.',
  };
}

export function failingDemoMissionBlocker(layout: Layout): DemoUnavailable | null {
  if (buildFailingDemoMission(layout) !== null) return null;

  return {
    code: 'NO_SHELF',
    message: 'This layout has no shelf to charge at. Add one in the station table.',
  };
}

/** The item name used when stocking a shelf for the demo. */
export const DEMO_ITEM = 'demo-crate';

/**
 * The layout with `DEMO_ITEM` added to the first shelf, or `null` when there is
 * no shelf or a shelf is already stocked.
 *
 * Pure, like everything else here — the caller decides whether to persist it.
 * This exists because `buildDemoMission` needs a stocked shelf and the M3
 * editor has no way to put an item on one; without it the demo button would be
 * permanently disabled on every layout the editor can produce.
 */
export function withDemoStock(layout: Layout): Layout | null {
  if (firstStockedShelf(layout) !== undefined) return null;

  const shelf = firstOfKind(layout, 'shelf');
  if (shelf === undefined) return null;

  return {
    ...layout,
    stations: layout.stations.map((station) =>
      station.id === shelf.id ? { ...station, items: [...stockOf(station), DEMO_ITEM] } : station,
    ),
  };
}

/**
 * Stations are searched in layout order so the same layout always yields the
 * same plan. Sorting by id or name would be equally deterministic but would
 * stop matching the order the station table shows.
 */
function firstOfKind(layout: Layout, kind: Station['kind']): Station | undefined {
  return layout.stations.find((station) => station.kind === kind);
}

function firstStockedShelf(layout: Layout): Station | undefined {
  return layout.stations.find((station) => station.kind === 'shelf' && stockOf(station).length > 0);
}

function stockOf(station: Station): string[] {
  return station.items ?? [];
}
