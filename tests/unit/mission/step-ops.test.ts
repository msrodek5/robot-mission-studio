import { describe, expect, it } from 'vitest';

import {
  STEP_OPS,
  defaultStationId,
  defaultStep,
  moveStep,
  stationLabel,
  withOp,
} from '../../../src/components/mission/step-ops';
import type { StepInput } from '../../../src/lib/schemas/mission';
import { StepSchema } from '../../../src/lib/schemas/mission';
import { validateMission } from '../../../src/lib/sim';
import { bench, grid } from '../sim/layouts';

const LAYOUT = bench();

describe('defaultStep', () => {
  it('produces a schema-valid step for every op the dropdown offers', () => {
    for (const op of STEP_OPS) {
      expect(StepSchema.safeParse(defaultStep(LAYOUT, op)).success).toBe(true);
    }
  });

  it('picks a station of the right kind so a new step is not born broken', () => {
    // A fresh CHARGE step aimed at a shelf would be an issue the user did not
    // create and has to clear before doing anything useful.
    expect(defaultStationId(LAYOUT, 'CHARGE')).toBe('charger-1');
    expect(defaultStationId(LAYOUT, 'PICK')).toBe('shelf-1');
    expect(defaultStationId(LAYOUT, 'MOVE_TO')).toBe('dock-1');
  });

  it('adds no new issues when appended to a valid plan', () => {
    const plan: StepInput[] = [
      { op: 'MOVE_TO', stationId: 'shelf-1' },
      { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
      { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
    ];

    for (const op of ['MOVE_TO', 'CHARGE', 'WAIT'] as const) {
      const issues = validateMission(LAYOUT, { steps: [...plan, defaultStep(LAYOUT, op)] });

      expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('degrades to an empty station id on a layout with no stations', () => {
    // The linter reports UNKNOWN_STATION rather than the editor throwing.
    expect(defaultStationId(grid(), 'PICK')).toBe('');
  });
});

describe('withOp', () => {
  it('carries the chosen station across an op change', () => {
    const step: StepInput = { op: 'MOVE_TO', stationId: 'charger-1' };

    expect(withOp(step, 'CHARGE', LAYOUT)).toEqual({
      op: 'CHARGE',
      stationId: 'charger-1',
      toPercent: 80,
    });
  });

  it('carries the item between PICK and PLACE', () => {
    const step: StepInput = { op: 'PICK', stationId: 'shelf-1', item: 'widget' };

    expect(withOp(step, 'PLACE', LAYOUT)).toMatchObject({ item: 'widget' });
  });

  it('returns the same step when the op is unchanged', () => {
    const step: StepInput = { op: 'PICK', stationId: 'shelf-1', item: 'bolt' };

    expect(withOp(step, 'PICK', LAYOUT)).toBe(step);
  });

  it('always produces a schema-valid step, from any op to any op', () => {
    for (const from of STEP_OPS) {
      for (const to of STEP_OPS) {
        const result = withOp(defaultStep(LAYOUT, from), to, LAYOUT);

        expect(StepSchema.safeParse(result).success).toBe(true);
        expect(result.op).toBe(to);
      }
    }
  });
});

describe('moveStep', () => {
  const steps: StepInput[] = [
    { op: 'MOVE_TO', stationId: 'shelf-1' },
    { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
    { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
  ];

  it('swaps a step with its neighbour', () => {
    expect(moveStep(steps, 1, -1).map((step) => step.op)).toEqual(['PICK', 'MOVE_TO', 'PLACE']);
    expect(moveStep(steps, 1, 1).map((step) => step.op)).toEqual(['MOVE_TO', 'PLACE', 'PICK']);
  });

  it('returns the same array at either end so a no-op click is not "dirty"', () => {
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, steps.length - 1, 1)).toBe(steps);
  });

  it('does not mutate the array it was given', () => {
    const before = [...steps];

    moveStep(steps, 0, 1);

    expect(steps).toEqual(before);
  });

  it('reordering is what surfaces a lint issue in the editor', () => {
    // The US-4 loop: move PICK after PLACE and the linter objects.
    const broken = moveStep(steps, 1, 1);

    expect(validateMission(LAYOUT, { steps: broken }).map((issue) => issue.code)).toContain(
      'GRIPPER_EMPTY',
    );
  });
});

describe('stationLabel', () => {
  it('shows the kind, because the linter cares about it', () => {
    expect(stationLabel(LAYOUT.stations[1])).toBe('Shelf (shelf)');
  });

  it('falls back to the id when a station has no name', () => {
    expect(stationLabel({ ...LAYOUT.stations[0], name: '  ' })).toBe('dock-1 (dock)');
  });
});
