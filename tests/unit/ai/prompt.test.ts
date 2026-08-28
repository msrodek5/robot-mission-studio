import { describe, expect, it } from 'vitest';

import {
  MISSION_JSON_SCHEMA,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildLayoutContext,
  buildRepairPrompt,
  buildUserPrompt,
} from '../../../src/lib/ai/prompts/plan-mission';
import { bench, grid } from '../sim/layouts';

describe('layout context', () => {
  const context = buildLayoutContext(bench());

  it('gives the model dimensions and the station list, as id | name | kind', () => {
    expect(context).toContain('5 wide by 5 tall');
    expect(context).toContain('shelf-1 | Shelf | shelf');
    expect(context).toContain('dock-1 | Dock | dock');
    expect(context).toContain('charger-1 | Charger | charger');
  });

  it('withholds everything A* owns', () => {
    // Coordinates, obstacles, and the start cell are all routing inputs. The
    // model emits MOVE_TO { stationId } and the simulator finds the path — a
    // model given cells would try to plan around walls, and do it worse.
    const walled = bench({ obstacles: [{ x: 1, y: 0 }], start: { x: 4, y: 4 } });
    const withObstacles = buildLayoutContext(walled);

    expect(withObstacles).not.toMatch(/obstacle/i);
    expect(withObstacles).not.toMatch(/start/i);
    expect(withObstacles).not.toContain('x:');
  });

  it('says so plainly when there is nothing to plan against', () => {
    expect(buildLayoutContext(grid())).toContain('no stations');
  });
});

describe('system prompt', () => {
  it('states the rules validateMission enforces', () => {
    // Stated up front so the repair loop is a backstop, not the mechanism.
    expect(SYSTEM_PROMPT).toMatch(/PICK before any PLACE/i);
    expect(SYSTEM_PROMPT).toMatch(/charger/i);
    expect(SYSTEM_PROMPT).toMatch(/Never invent a station id/i);
    expect(SYSTEM_PROMPT).toMatch(/Do not plan a route/i);
  });

  it('is pinned by a version that is persisted with every plan', () => {
    expect(PROMPT_VERSION).toBe('plan-v1');
  });
});

describe('the emit_mission tool schema', () => {
  it('is derived from MissionSchema rather than hand-written', () => {
    // Add a Step variant and this grows on its own. A hand-copied JSON Schema
    // would not, and the model could no longer emit the new op.
    expect(MISSION_JSON_SCHEMA).toMatchObject({ type: 'object', required: ['steps'] });

    const ops = JSON.stringify(MISSION_JSON_SCHEMA);

    for (const op of ['MOVE_TO', 'PICK', 'PLACE', 'WAIT', 'CHARGE']) {
      expect(ops).toContain(op);
    }
  });

  it('offers no way to express a grid coordinate', () => {
    const schema = JSON.stringify(MISSION_JSON_SCHEMA);

    expect(schema).not.toContain('cell');
    expect(schema).not.toMatch(/"[xy]"/);
  });
});

describe('user and repair prompts', () => {
  it('puts the brief after the layout context', () => {
    const prompt = buildUserPrompt(bench(), 'fetch a bolt');

    expect(prompt.indexOf('Stations')).toBeLessThan(prompt.indexOf('fetch a bolt'));
  });

  it('lists the problems and asks for the whole plan back', () => {
    const repair = buildRepairPrompt(['UNKNOWN_STATION in step 0: no such station']);

    expect(repair).toContain('UNKNOWN_STATION in step 0');
    expect(repair).toMatch(/complete plan/i);
  });
});
