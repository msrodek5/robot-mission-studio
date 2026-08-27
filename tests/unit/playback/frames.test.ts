import { describe, expect, it } from 'vitest';

import { manhattan, simulate } from '../../../src/lib/sim';
import type { Mission } from '../../../src/lib/sim';
import { bench } from '../sim/layouts';
import { runFixtures } from './run-fixtures';

/**
 * Invariants the player relies on.
 *
 * The scrubber indexes frames directly and the grid draws one robot per frame,
 * so a gap in the frame list shows up as the robot teleporting. These are the
 * three things that would have to hold for the animation to be honest, asserted
 * rather than assumed.
 */
describe('frame invariants', () => {
  for (const fixture of runFixtures()) {
    it(`has one frame per tick plus the starting frame — ${fixture.name}`, () => {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);

      // Frame 0 is the robot standing on `start` before anything happens, so the
      // scrubber's range is 0..ticks and its length is ticks + 1.
      expect(result.frames).toHaveLength(result.ticks + 1);
      expect(result.frames.map((frame) => frame.tick)).toEqual(
        Array.from({ length: result.ticks + 1 }, (_, tick) => tick),
      );
    });

    it(`moves at most one cell between frames — ${fixture.name}`, () => {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);

      for (let i = 1; i < result.frames.length; i += 1) {
        const from = result.frames[i - 1].pos;
        const to = result.frames[i].pos;

        expect(manhattan(from, to)).toBeLessThanOrEqual(1);
      }
    });

    it(`never gains battery outside a CHARGE step — ${fixture.name}`, () => {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);
      let gained = 0;

      for (let i = 1; i < result.frames.length; i += 1) {
        const previous = result.frames[i - 1];
        const frame = result.frames[i];

        if (frame.battery <= previous.battery) continue;

        // A rise is only legal while a CHARGE step is executing.
        expect(fixture.mission.steps[frame.stepIndex]?.op).toBe('CHARGE');
        gained += 1;
      }

      // And the charging fixture must actually charge, or the exception above
      // would be untested.
      expect(gained > 0).toBe(fixture.charges);
    });

    it(`stays inside the grid and off the obstacles — ${fixture.name}`, () => {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);
      const blocked = new Set(fixture.layout.obstacles.map((cell) => `${cell.x},${cell.y}`));

      for (const frame of result.frames) {
        expect(frame.pos.x).toBeGreaterThanOrEqual(0);
        expect(frame.pos.y).toBeGreaterThanOrEqual(0);
        expect(frame.pos.x).toBeLessThan(fixture.layout.width);
        expect(frame.pos.y).toBeLessThan(fixture.layout.height);
        expect(blocked.has(`${frame.pos.x},${frame.pos.y}`)).toBe(false);
      }
    });

    it(`points every frame at a real step — ${fixture.name}`, () => {
      const result = simulate(fixture.layout, fixture.mission, fixture.opts);

      // The step list highlights `frames[i].stepIndex`; an out-of-range index
      // would highlight nothing and give no clue why.
      for (const frame of result.frames) {
        expect(frame.stepIndex).toBeGreaterThanOrEqual(0);
        expect(frame.stepIndex).toBeLessThan(fixture.mission.steps.length);
      }
    });
  }

  it('holds on a failed run too — frames stop where the failure did', () => {
    const layout = bench();
    const mission: Mission = {
      steps: [
        { op: 'MOVE_TO', stationId: 'shelf-1' },
        { op: 'CHARGE', stationId: 'shelf-1', toPercent: 100 },
      ],
    };

    const result = simulate(layout, mission, { seed: 0 });

    expect(result.status).toBe('failed');
    expect(result.frames).toHaveLength(result.ticks + 1);
    expect(result.frames[result.frames.length - 1].pos).toEqual({ x: 2, y: 0 });
  });

  it('produces a single frame for a mission that fails before moving', () => {
    const layout = bench();
    const mission: Mission = { steps: [{ op: 'MOVE_TO', stationId: 'nope' }] };

    const result = simulate(layout, mission, { seed: 0 });

    // The scrubber has to cope with a zero-length range without dividing by it.
    expect(result.frames).toHaveLength(1);
    expect(result.ticks).toBe(0);
    expect(result.failure?.code).toBe('UNKNOWN_STATION');
  });
});
