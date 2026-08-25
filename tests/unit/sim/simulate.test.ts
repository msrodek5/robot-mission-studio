import { describe, expect, it } from 'vitest';

import { simulate, stripFrames } from '../../../src/lib/sim';
import type { Mission, RunResult, SimOptions } from '../../../src/lib/sim';
import { bench, cells, grid } from './layouts';

const seed: SimOptions = { seed: 1 };

function run(mission: Mission, options: SimOptions = seed, layout = bench()): RunResult {
  return simulate(layout, mission, options);
}

describe('simulate — happy path', () => {
  const mission: Mission = {
    steps: [
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      { op: 'MOVE_TO', stationId: 'dock-1' },
      { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
    ],
  };

  it('completes and reports the cost model', () => {
    const result = run(mission);

    // 4 cells moved (2 out, 2 back) = 4 ticks and 2%; two handling ops = 4
    // ticks and 2%.
    expect(result.status).toBe('success');
    expect(result.failure).toBeUndefined();
    expect(result.ticks).toBe(8);
    expect(result.distance).toBe(4);
    expect(result.batteryEnd).toBe(96);
  });

  it('logs one entry per step', () => {
    const result = run(mission);

    expect(result.log).toHaveLength(4);
    expect(result.log.map((entry) => entry.op)).toEqual(['MOVE_TO', 'PICK', 'MOVE_TO', 'PLACE']);
    expect(result.log.every((entry) => entry.outcome === 'ok')).toBe(true);
  });

  it('emits one frame per tick plus the starting frame', () => {
    const result = run(mission);

    expect(result.frames).toHaveLength(result.ticks + 1);
    expect(result.frames[0]).toEqual({
      tick: 0,
      stepIndex: 0,
      pos: { x: 0, y: 0 },
      battery: 100,
      carrying: null,
    });
    expect(result.frames[result.frames.length - 1].carrying).toBeNull();
  });

  it('walks to the station implicitly when a PICK has no preceding MOVE_TO', () => {
    const result = run({ steps: [{ op: 'PICK', stationId: 'shelf-1', item: 'bolt' }] });

    expect(result.status).toBe('success');
    expect(result.distance).toBe(2);
    expect(result.ticks).toBe(4);
    expect(result.batteryEnd).toBe(98);
  });
});

describe('simulate — one test per failure code', () => {
  it('UNKNOWN_STATION', () => {
    const result = run({ steps: [{ op: 'MOVE_TO', stationId: 'shelf-404' }] });

    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('UNKNOWN_STATION');
    expect(result.failure?.stepIndex).toBe(0);
    expect(result.ticks).toBe(0);
  });

  it('UNREACHABLE', () => {
    // Full-height wall on x=3 seals the charger off from the start cell.
    const layout = bench({ obstacles: cells([3, 0], [3, 1], [3, 2], [3, 3], [3, 4]) });
    const result = run({ steps: [{ op: 'MOVE_TO', stationId: 'charger-1' }] }, seed, layout);

    expect(result.failure?.code).toBe('UNREACHABLE');
    expect(result.distance).toBe(0);
  });

  it('GRIPPER_FULL', () => {
    const result = run({
      steps: [
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
        { op: 'PICK', stationId: 'shelf-1', item: 'nut' },
      ],
    });

    expect(result.failure).toMatchObject({ code: 'GRIPPER_FULL', stepIndex: 1 });
  });

  it('GRIPPER_EMPTY', () => {
    const result = run({ steps: [{ op: 'PLACE', stationId: 'dock-1', item: 'bolt' }] });

    expect(result.failure).toMatchObject({ code: 'GRIPPER_EMPTY', stepIndex: 0 });
  });

  it('ITEM_NOT_PRESENT', () => {
    const result = run({ steps: [{ op: 'PICK', stationId: 'shelf-1', item: 'flange' }] });

    expect(result.failure).toMatchObject({ code: 'ITEM_NOT_PRESENT', stepIndex: 0 });
  });

  it('ITEM_NOT_PRESENT after the item has already been taken', () => {
    const result = run({
      steps: [
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      ],
    });

    expect(result.failure).toMatchObject({ code: 'ITEM_NOT_PRESENT', stepIndex: 2 });
  });

  it('WRONG_STATION_KIND', () => {
    const result = run({ steps: [{ op: 'CHARGE', stationId: 'dock-1', toPercent: 100 }] });

    expect(result.failure).toMatchObject({ code: 'WRONG_STATION_KIND', stepIndex: 0 });
  });

  it('BATTERY_DEPLETED', () => {
    // 1.0% buys exactly one cell. The second lands on precisely 0, and a robot
    // at 0% does not finish the cell it is halfway across — so the run stops
    // one cell in, three cells short of the charger.
    const result = run({ steps: [{ op: 'MOVE_TO', stationId: 'charger-1' }] }, {
      seed: 1,
      batteryStart: 1,
    });

    expect(result.failure).toMatchObject({ code: 'BATTERY_DEPLETED', stepIndex: 0 });
    expect(result.distance).toBe(1);
    expect(result.ticks).toBe(1);
    expect(result.batteryEnd).toBe(0.5);
    expect(result.failure?.detail).toContain('3 cell(s) short');
  });

  it('BATTERY_DEPLETED partway through a step, keeping the ticks already spent', () => {
    const result = run({ steps: [{ op: 'MOVE_TO', stationId: 'charger-1' }] }, {
      seed: 1,
      batteryStart: 1.2,
    });

    expect(result.distance).toBe(2);
    expect(result.ticks).toBe(2);
    expect(result.batteryEnd).toBe(0.2);
    expect(result.frames).toHaveLength(3);
  });
});

describe('simulate — battery model', () => {
  it('charges at 1 tick per 5% and stops at the target', () => {
    const result = run(
      {
        steps: [
          { op: 'MOVE_TO', stationId: 'charger-1' },
          { op: 'CHARGE', stationId: 'charger-1', toPercent: 100 },
        ],
      },
      { seed: 1, batteryStart: 50 },
    );

    // 4 cells -> 48%. Closing a 52% gap takes ceil(52 / 5) = 11 ticks.
    expect(result.status).toBe('success');
    expect(result.batteryEnd).toBe(100);
    expect(result.ticks).toBe(4 + 11);
  });

  it('treats CHARGE as a no-op when already above the target', () => {
    const result = run({
      steps: [
        { op: 'MOVE_TO', stationId: 'charger-1' },
        { op: 'CHARGE', stationId: 'charger-1', toPercent: 50 },
      ],
    });

    expect(result.ticks).toBe(4);
    expect(result.batteryEnd).toBe(98);
  });

  it('spends no battery while waiting', () => {
    const result = run({ steps: [{ op: 'WAIT', ticks: 3 }] });

    expect(result.status).toBe('success');
    expect(result.ticks).toBe(3);
    expect(result.distance).toBe(0);
    expect(result.batteryEnd).toBe(100);
  });

  it('keeps halves exact rather than drifting', () => {
    // 30 single-cell moves at 0.5% each must land on precisely 85%.
    const layout = grid({
      width: 16,
      height: 16,
      stations: [
        { id: 'a', name: 'A', cell: { x: 0, y: 0 }, kind: 'dock' },
        { id: 'b', name: 'B', cell: { x: 15, y: 15 }, kind: 'dock' },
      ],
    });
    const result = run({ steps: [{ op: 'MOVE_TO', stationId: 'b' }] }, seed, layout);

    expect(result.distance).toBe(30);
    expect(result.batteryEnd).toBe(85);
  });
});

describe('simulate — determinism', () => {
  const mission: Mission = {
    steps: [
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      { op: 'WAIT', ticks: 2 },
      { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
      { op: 'CHARGE', stationId: 'charger-1', toPercent: 100 },
    ],
  };

  it('produces byte-identical results across repeated runs', () => {
    expect(run(mission)).toEqual(run(mission));
  });

  it('ignores the seed in v1', () => {
    // The slot exists so stochastic events can arrive later without changing
    // this signature. Until then it must not move a single tick.
    expect(run(mission, { seed: 1 })).toEqual(run(mission, { seed: 999 }));
  });

  it('does not mutate the layout it was given', () => {
    const layout = bench();
    const before = JSON.stringify(layout);

    run(mission, seed, layout);

    expect(JSON.stringify(layout)).toBe(before);
  });
});

describe('stripFrames', () => {
  it('drops frames so a run can be persisted', () => {
    const persisted = stripFrames(run({ steps: [{ op: 'WAIT', ticks: 1 }] }));

    expect(persisted).not.toHaveProperty('frames');
    expect(persisted).toHaveProperty('log');
  });
});
