import { describe, expect, it } from 'vitest';

import { hasBlockingIssues, validateMission } from '../../../src/lib/sim';
import type { Issue, IssueCode, Mission } from '../../../src/lib/sim';
import { bench } from './layouts';

function codes(issues: Issue[]): IssueCode[] {
  return issues.map((issue) => issue.code);
}

const layout = bench();

describe('validateMission', () => {
  it('accepts a well-formed mission', () => {
    const mission: Mission = {
      steps: [
        { op: 'MOVE_TO', stationId: 'shelf-1' },
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
        { op: 'CHARGE', stationId: 'charger-1', toPercent: 100 },
      ],
    };

    expect(validateMission(layout, mission)).toEqual([]);
  });

  it('rejects an empty mission and reports nothing else', () => {
    const issues = validateMission(layout, { steps: [] });

    expect(codes(issues)).toEqual(['EMPTY_MISSION']);
    expect(issues[0].stepIndex).toBeNull();
  });

  it('flags an unknown station id', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'MOVE_TO', stationId: 'shelf-9' }],
    });

    expect(codes(issues)).toEqual(['UNKNOWN_STATION']);
    expect(issues[0].stepIndex).toBe(0);
  });

  it('flags PLACE without a prior PICK', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'PLACE', stationId: 'dock-1', item: 'bolt' }],
    });

    expect(codes(issues)).toEqual(['GRIPPER_EMPTY']);
  });

  it('flags a second PICK while already carrying', () => {
    const issues = validateMission(layout, {
      steps: [
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
        { op: 'PICK', stationId: 'shelf-1', item: 'nut' },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
      ],
    });

    expect(codes(issues)).toEqual(['GRIPPER_FULL']);
  });

  it('flags CHARGE at a station that is not a charger', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'CHARGE', stationId: 'dock-1', toPercent: 80 }],
    });

    expect(codes(issues)).toEqual(['WRONG_STATION_KIND']);
  });

  it('flags PICK at a dock', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'PICK', stationId: 'dock-1', item: 'bolt' }],
    });

    expect(codes(issues)).toContain('WRONG_STATION_KIND');
  });

  it('flags a non-positive or fractional WAIT', () => {
    const issues = validateMission(layout, {
      steps: [
        { op: 'WAIT', ticks: 0 },
        { op: 'WAIT', ticks: -3 },
        { op: 'WAIT', ticks: 1.5 },
        { op: 'WAIT', ticks: 4 },
      ],
    });

    expect(codes(issues)).toEqual(['INVALID_WAIT', 'INVALID_WAIT', 'INVALID_WAIT']);
    expect(issues.map((issue) => issue.stepIndex)).toEqual([0, 1, 2]);
  });

  it('flags an out-of-range charge target', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'CHARGE', stationId: 'charger-1', toPercent: 140 }],
    });

    expect(codes(issues)).toEqual(['INVALID_CHARGE_TARGET']);
  });

  it('warns, but does not block, when the mission ends holding an item', () => {
    const issues = validateMission(layout, {
      steps: [{ op: 'PICK', stationId: 'shelf-1', item: 'bolt' }],
    });

    expect(codes(issues)).toEqual(['ENDS_CARRYING']);
    expect(issues[0].severity).toBe('warning');
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('keeps the gripper model advancing past a broken step', () => {
    // Step 0 is unknown, but step 2 must still be reported as placing with an
    // empty gripper rather than silently inheriting a confused state.
    const issues = validateMission(layout, {
      steps: [
        { op: 'MOVE_TO', stationId: 'nowhere' },
        { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
      ],
    });

    expect(codes(issues)).toEqual(['UNKNOWN_STATION', 'GRIPPER_EMPTY']);
    expect(issues[1].stepIndex).toBe(3);
  });

  it('reports every issue rather than stopping at the first', () => {
    const issues = validateMission(layout, {
      steps: [
        { op: 'CHARGE', stationId: 'dock-1', toPercent: 200 },
        { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
      ],
    });

    expect(codes(issues)).toEqual([
      'WRONG_STATION_KIND',
      'INVALID_CHARGE_TARGET',
      'GRIPPER_EMPTY',
    ]);
    expect(hasBlockingIssues(issues)).toBe(true);
  });
});
