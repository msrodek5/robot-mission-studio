import { describe, expect, it } from 'vitest';

import { simulate, stripFrames } from '../../../src/lib/sim';
import type { Layout, Mission, RunResult, SimOptions } from '../../../src/lib/sim';
import batteryDepleted from '../../fixtures/golden-battery-depleted.json';
import fetchAndCharge from '../../fixtures/golden-fetch-and-charge.json';

type GoldenFixture = {
  name: string;
  description: string;
  layout: Layout;
  mission: Mission;
  options: SimOptions;
  /** The whole `RunResult` except `frames`, which are never persisted. */
  expected: Omit<RunResult, 'frames'>;
};

// JSON imports widen string literals ('shelf' -> string), so the union types in
// Layout and Step have to be re-asserted here. The golden run itself is what
// proves the data is well formed.
const fixtures = [fetchAndCharge, batteryDepleted] as unknown as GoldenFixture[];

describe('golden runs', () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it('reproduces the recorded result exactly', () => {
        const result = simulate(fixture.layout, fixture.mission, fixture.options);

        expect(stripFrames(result)).toEqual(fixture.expected);
      });

      it('recomputes frames from layout + mission + seed alone', () => {
        // The determinism payoff: frames are absent from the fixture and from
        // the database, and a rerun rebuilds them tick for tick.
        const first = simulate(fixture.layout, fixture.mission, fixture.options);
        const second = simulate(fixture.layout, fixture.mission, fixture.options);

        expect(fixture.expected).not.toHaveProperty('frames');
        expect(second.frames).toEqual(first.frames);
        expect(first.frames).toHaveLength(first.ticks + 1);
      });
    });
  }
});
