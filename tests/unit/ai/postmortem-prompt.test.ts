import { describe, expect, it } from 'vitest';

import {
  LOG_TAIL,
  POSTMORTEM_JSON_SCHEMA,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildFailureContext,
  buildLayoutContext,
  buildLogContext,
  buildPlanContext,
  buildRepairPrompt,
  buildUserPrompt,
} from '../../../src/lib/ai/prompts/postmortem';
import { simulate } from '../../../src/lib/sim';
import type { Failure, LogEntry, Mission } from '../../../src/lib/sim';
import { bench, cells, grid } from '../sim/layouts';

/**
 * A plan that fails for a reason the log explains and the failure alone does not.
 *
 * The gripper is full at step 2 *because* step 1 filled it — which is exactly the
 * kind of thing the postmortem exists to say, and exactly what is invisible
 * without the entries leading up to the failure.
 */
const MISSION: Mission = {
  steps: [
    { op: 'MOVE_TO', stationId: 'shelf-1' },
    { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
    { op: 'PICK', stationId: 'shelf-1', item: 'nut' },
    { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
  ],
};

/** Run it for real rather than hand-writing a failure the simulator never emits. */
function failedRun(): { failure: Failure; log: LogEntry[] } {
  const result = simulate(bench(), MISSION, { seed: 0 });

  if (result.failure === undefined) throw new Error('fixture mission was supposed to fail');

  return { failure: result.failure, log: result.log };
}

describe('layout context', () => {
  const context = buildLayoutContext(bench());

  it('gives the model dimensions and the station list, as id | name | kind', () => {
    expect(context).toContain('5 wide by 5 tall');
    expect(context).toContain('shelf-1 | Shelf | shelf');
    expect(context).toContain('dock-1 | Dock | dock');
    expect(context).toContain('charger-1 | Charger | charger');
  });

  it('withholds the obstacle grid and the start cell', () => {
    // The postmortem explains a route the simulator already chose. A model handed
    // a wall map narrates a path the robot never took; the log says where it
    // actually went.
    const walled = buildLayoutContext(
      bench({ obstacles: cells([1, 0], [3, 0]), start: { x: 4, y: 4 } }),
    );

    expect(walled).not.toMatch(/obstacle/i);
    expect(walled).not.toMatch(/start/i);
    expect(walled).not.toContain('"cell"');
  });

  it('says so plainly when the layout has no stations', () => {
    expect(buildLayoutContext(grid())).toContain('Stations: none');
  });
});

describe('plan context', () => {
  const context = buildPlanContext(MISSION);

  it('prints the 0-based index of every step', () => {
    // The index is the anchor for every suggested edit. A model counting list
    // positions itself gets it wrong, so it is stated rather than implied.
    expect(context).toContain('0-based');
    expect(context).toContain('0 | MOVE_TO shelf-1');
    expect(context).toContain('1 | PICK "bolt" at shelf-1');
    expect(context).toContain('2 | PICK "nut" at shelf-1');
    expect(context).toContain('3 | PLACE "bolt" at dock-1');
  });

  it('states the step count so the model knows the valid range', () => {
    expect(context).toContain('4 steps');
  });

  it('handles an empty plan without inventing one', () => {
    expect(buildPlanContext({ steps: [] })).toContain('empty');
  });
});

describe('failure context', () => {
  it('passes the failure object through field by field', () => {
    const { failure } = failedRun();

    const context = buildFailureContext(failure);

    expect(failure.code).toBe('GRIPPER_FULL');
    expect(context).toContain('step index: 2');
    expect(context).toContain('code: GRIPPER_FULL');
    expect(context).toContain(failure.detail);
  });
});

describe('log context', () => {
  it('renders each entry with its tick, step, position, and battery', () => {
    const { log } = failedRun();

    const context = buildLogContext(log);

    expect(context).toContain('oldest first');
    expect(context).toContain('tick ');
    expect(context).toContain('battery ');
    // The cause is in the entries before the failure, not in the failure.
    expect(context).toContain('Picked "bolt"');
  });

  it(`sends at most the last ${LOG_TAIL} entries and says how many it dropped`, () => {
    const long: LogEntry[] = Array.from({ length: LOG_TAIL + 5 }, (_entry, index) => ({
      tick: index,
      stepIndex: index,
      op: 'WAIT',
      outcome: 'ok',
      message: `entry ${index}`,
      pos: { x: 0, y: 0 },
      battery: 100,
    }));

    const context = buildLogContext(long);

    expect(context).toContain(`last ${LOG_TAIL} of ${LOG_TAIL + 5}`);
    expect(context).toContain('5 earlier omitted');
    // The *tail* is what is kept: entries 0..4 are gone, 5..24 are not. Getting
    // this backwards would drop the failure itself, which is the last entry.
    expect(context).not.toContain('— entry 4');
    expect(context).toContain('— entry 5');
    expect(context).toContain(`— entry ${LOG_TAIL + 4}`);
  });

  it('says the run failed before any step when the log is empty', () => {
    expect(buildLogContext([])).toContain('empty');
  });
});

describe('system prompt', () => {
  it('states the rules the gate enforces', () => {
    // Stated up front so the repair loop is a backstop, not the mechanism.
    expect(SYSTEM_PROMPT).toMatch(/0-based/);
    expect(SYSTEM_PROMPT).toMatch(/must be indices that exist/i);
    expect(SYSTEM_PROMPT).toMatch(/never invent one/i);
    expect(SYSTEM_PROMPT).toMatch(/empty list/i);
  });

  it('tells the model who is reading and bans the failure code as an answer', () => {
    // US-6 is "understand why it failed without reading a trace". Echoing
    // GRIPPER_FULL back at the user is the failure mode this rules out.
    expect(SYSTEM_PROMPT).toMatch(/not a roboticist/i);
    expect(SYSTEM_PROMPT).toMatch(/Do not quote the failure code/i);
    expect(SYSTEM_PROMPT).toMatch(/never by coordinates/i);
  });

  it('is pinned by a version that is persisted with every postmortem', () => {
    expect(PROMPT_VERSION).toBe('postmortem-v1');
  });
});

describe('the emit_postmortem tool schema', () => {
  it('is derived from PostmortemSchema rather than hand-written', () => {
    expect(POSTMORTEM_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['diagnosis', 'suggestedEdits'],
    });
  });

  it('carries the caps into the schema, so they are guidance before they are a gate', () => {
    const schema = JSON.stringify(POSTMORTEM_JSON_SCHEMA);

    expect(schema).toContain('maxLength');
    expect(schema).toContain('maxItems');
    // Every edit is anchored: an unanchored suggestion cannot even be expressed.
    expect(schema).toContain('stepIndex');
  });
});

describe('user and repair prompts', () => {
  it('puts the stable half first and the run-specific half after it', () => {
    const { failure, log } = failedRun();
    const prompt = buildUserPrompt(bench(), MISSION, failure, log);

    expect(prompt.indexOf('Stations')).toBeLessThan(prompt.indexOf('Plan ('));
    expect(prompt.indexOf('Plan (')).toBeLessThan(prompt.indexOf('Failure:'));
    expect(prompt.indexOf('Failure:')).toBeLessThan(prompt.indexOf('Log ('));
  });

  it('carries nothing but the five grounded inputs', () => {
    const { failure, log } = failedRun();
    const prompt = buildUserPrompt(
      bench({ obstacles: cells([1, 1], [2, 2]) }),
      MISSION,
      failure,
      log,
    );

    expect(prompt).not.toMatch(/obstacle/i);
    expect(prompt).not.toMatch(/frame/i);
  });

  it('lists the problems and asks for the whole postmortem back', () => {
    const repair = buildRepairPrompt(['suggestedEdits refers to step 9, but the plan has 4 steps']);

    expect(repair).toContain('step 9');
    expect(repair).toMatch(/Return the whole/i);
  });
});
