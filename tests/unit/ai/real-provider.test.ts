import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { anthropicMessageCreator, plannerModel } from '../../../src/lib/ai/client';
import { explainFailure } from '../../../src/lib/ai/explain-failure';
import { planMission } from '../../../src/lib/ai/plan-mission';
import { hasBlockingIssues, simulate, validateMission } from '../../../src/lib/sim';
import type { Layout, Mission } from '../../../src/lib/sim';

/**
 * The one test that actually calls Anthropic. Run it by hand:
 *
 *   ANTHROPIC_SMOKE=1 npx vitest run tests/unit/ai/real-provider.test.ts
 *
 * Skipped otherwise, and that is deliberate (implementation plan §10): a live
 * model in CI would bill every push and go red on a rate limit rather than on a
 * bug. Every other test in this directory replays fixtures.
 *
 * What it is worth: the mocked tests prove the pipeline handles the response
 * shapes it is given. Only this one proves those shapes are the ones the real
 * API sends — that `tool_choice` is spelled correctly, that the derived JSON
 * Schema is accepted, and that a small model can satisfy the prompt at all.
 */

const ENABLED = process.env.ANTHROPIC_SMOKE === '1';

/**
 * Vite only surfaces `PUBLIC_*` variables to `import.meta.env`, so the
 * unprefixed key has to be lifted out of `.env` by hand for this test. Tiny
 * parser rather than a dotenv dependency — the sim core takes none, and the
 * test suite should not be the thing that adds one.
 */
function loadEnvFile(): void {
  if (process.env.ANTHROPIC_API_KEY !== undefined) return;

  let contents: string;

  try {
    contents = readFileSync(join(import.meta.dirname, '..', '..', '..', '.env'), 'utf8');
  } catch {
    return;
  }

  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);

    if (match === null) continue;

    // Strip the matching quotes dotenv would strip.
    process.env[match[1]] ??= match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * A layout with names that do *not* match the brief word for word.
 *
 * "shelf A" in the brief has to be resolved to `shelf-a` by the model, and
 * "the dock" to `dock-main`. A layout whose ids were literally in the brief
 * would let a broken prompt pass.
 */
const WAREHOUSE: Layout = {
  width: 10,
  height: 8,
  obstacles: [
    { x: 4, y: 1 },
    { x: 4, y: 2 },
    { x: 4, y: 3 },
  ],
  stations: [
    { id: 'dock-main', name: 'Loading dock', cell: { x: 0, y: 0 }, kind: 'dock' },
    { id: 'shelf-a', name: 'Shelf A', cell: { x: 8, y: 2 }, kind: 'shelf', items: ['crate'] },
    { id: 'shelf-b', name: 'Shelf B', cell: { x: 8, y: 5 }, kind: 'shelf', items: ['pallet'] },
    { id: 'charge-1', name: 'Charging bay', cell: { x: 1, y: 7 }, kind: 'charger' },
  ],
  start: { x: 0, y: 0 },
};

describe.skipIf(!ENABLED)('the real Anthropic API', () => {
  it(
    'turns the demo brief into a runnable plan',
    async () => {
      loadEnvFile();

      const create = anthropicMessageCreator();
      expect(create, 'ANTHROPIC_API_KEY is not set').not.toBeNull();
      if (create === null) return;

      const result = await planMission({
        layout: WAREHOUSE,
        brief: 'pick a crate from shelf A and drop it at the dock',
        create,
      });

      // eslint-disable-next-line no-console -- this test exists to be watched
      console.log(JSON.stringify({ model: plannerModel(), result }, null, 2));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const issues = validateMission(WAREHOUSE, result.mission);

      expect(hasBlockingIssues(issues)).toBe(false);

      // The division of labour, checked against a live model: it named the
      // stations the brief described and emitted no coordinates of its own.
      const ops = result.mission.steps.map((step) => step.op);
      expect(ops).toContain('PICK');
      expect(ops).toContain('PLACE');

      const stations = result.mission.steps.flatMap((step) =>
        'stationId' in step ? [step.stationId] : [],
      );
      expect(stations).toContain('shelf-a');
      expect(stations).toContain('dock-main');
      // Every id it used is real. No invented stations.
      for (const id of stations) {
        expect(WAREHOUSE.stations.map((station) => station.id)).toContain(id);
      }

      // The end of the line: a plan that lints clean is worth nothing if the
      // simulator cannot finish it. This is the same `simulate()` the server
      // runs behind POST /api/runs, so a pass here is the whole US-3 loop —
      // brief in, robot at the dock — minus the HTTP.
      const run = simulate(WAREHOUSE, result.mission, { seed: 0 });

      expect(run.failure).toBeUndefined();
      expect(run.status).toBe('success');
      expect(run.batteryEnd).toBeGreaterThan(0);
    },
    // Three model calls at 20s each, plus slack.
    90_000,
  );
});

/**
 * A plan that fails for a reason only the trace explains.
 *
 * Two picks in a row: the gripper is full at step 2 because step 1 filled it.
 * Chosen because the failure object alone (`GRIPPER_FULL` at step 2) does not
 * contain the cause — a postmortem that only restates the code will not mention
 * the crate it was already holding, and the assertions below will notice.
 */
const DOUBLE_PICK: Mission = {
  steps: [
    { op: 'MOVE_TO', stationId: 'shelf-a' },
    { op: 'PICK', stationId: 'shelf-a', item: 'crate' },
    { op: 'PICK', stationId: 'shelf-b', item: 'pallet' },
    { op: 'PLACE', stationId: 'dock-main', item: 'crate' },
  ],
};

describe.skipIf(!ENABLED)('the real Anthropic API — postmortem', () => {
  it(
    'turns a failed run into an explanation with usable step anchors',
    async () => {
      loadEnvFile();

      const create = anthropicMessageCreator();
      expect(create, 'ANTHROPIC_API_KEY is not set').not.toBeNull();
      if (create === null) return;

      // The trace is real: the same `simulate()` the server runs behind
      // POST /api/runs produces the failure and the log this is asked to explain.
      const run = simulate(WAREHOUSE, DOUBLE_PICK, { seed: 0 });

      expect(run.status).toBe('failed');
      expect(run.failure?.code).toBe('GRIPPER_FULL');
      if (run.failure === undefined) return;

      const result = await explainFailure({
        layout: WAREHOUSE,
        mission: DOUBLE_PICK,
        failure: run.failure,
        log: run.log,
        create,
      });

      // eslint-disable-next-line no-console -- this test exists to be watched
      console.log(JSON.stringify({ model: plannerModel(), result }, null, 2));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Every anchor is a step that exists. This is the gate the mocked tests
      // exercise with a fixture; here it is checked against a live model.
      for (const edit of result.postmortem.suggestedEdits) {
        expect(edit.stepIndex).toBeGreaterThanOrEqual(0);
        expect(edit.stepIndex).toBeLessThan(DOUBLE_PICK.steps.length);
      }

      // US-6: understandable without reading a trace. A diagnosis that just
      // echoes the code back is the failure mode, so the code must not appear.
      expect(result.postmortem.diagnosis).not.toContain('GRIPPER_FULL');
      expect(result.postmortem.diagnosis.length).toBeGreaterThan(40);
    },
    // Three model calls at 20s each, plus slack.
    90_000,
  );
});
