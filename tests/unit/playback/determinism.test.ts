import { describe, expect, it } from 'vitest';

import { simulate, stripFrames } from '../../../src/lib/sim';
import { runFixtures } from './run-fixtures';

/**
 * The contract playback depends on.
 *
 * Runs persist their result but never their frames (CLAUDE.md rule 6), so the
 * browser rebuilds frames by re-running `simulate()` with the same layout, plan,
 * and seed. That is only safe if two calls are indistinguishable — which is what
 * these assert, on the same three fixtures the frame-invariant tests use.
 *
 * The playback island makes the same comparison at runtime and refuses to
 * animate if it fails. This is the version that fails in CI first.
 */
describe('simulate is byte-identical across calls', () => {
  for (const fixture of runFixtures()) {
    it(`gives the same persisted result twice — ${fixture.name}`, () => {
      const first = simulate(fixture.layout, fixture.mission, fixture.opts);
      const second = simulate(fixture.layout, fixture.mission, fixture.opts);

      // Byte-identical, not merely deep-equal: key order is part of what gets
      // written to jsonb and compared after a round trip.
      expect(JSON.stringify(stripFrames(second))).toBe(JSON.stringify(stripFrames(first)));
    });

    it(`gives the same frames twice — ${fixture.name}`, () => {
      const first = simulate(fixture.layout, fixture.mission, fixture.opts);
      const second = simulate(fixture.layout, fixture.mission, fixture.opts);

      // Not part of the persisted contract, but if frames diverged while the
      // summary held, playback would animate a run that never happened.
      expect(JSON.stringify(second.frames)).toBe(JSON.stringify(first.frames));
    });

    it(`is unaffected by a fresh layout object with the same contents — ${fixture.name}`, () => {
      const clone = JSON.parse(JSON.stringify(fixture.layout));
      const cloneMission = JSON.parse(JSON.stringify(fixture.mission));

      const fromOriginal = simulate(fixture.layout, fixture.mission, fixture.opts);
      const fromClone = simulate(clone, cloneMission, fixture.opts);

      // The server simulates against a layout parsed out of jsonb and the
      // browser against one parsed out of JSON. Same bytes in, same run out.
      expect(JSON.stringify(stripFrames(fromClone))).toBe(
        JSON.stringify(stripFrames(fromOriginal)),
      );
    });
  }

  it('does not let the seed change the outcome in v1', () => {
    const [fixture] = runFixtures();

    const withZero = simulate(fixture.layout, fixture.mission, { ...fixture.opts, seed: 0 });
    const withOther = simulate(fixture.layout, fixture.mission, { ...fixture.opts, seed: 99 });

    // `seed` is reserved for stochastic events and must not influence v1 output.
    // When it starts to matter, this test is the one that should fail and be
    // rewritten deliberately.
    expect(JSON.stringify(stripFrames(withOther))).toBe(JSON.stringify(stripFrames(withZero)));
  });

  it('never includes frames in the persisted half of a result', () => {
    const [fixture] = runFixtures();
    const persisted = stripFrames(simulate(fixture.layout, fixture.mission, fixture.opts));

    expect('frames' in persisted).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(persisted)))).not.toContain('frames');
  });
});
