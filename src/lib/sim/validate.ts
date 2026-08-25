import { findStation } from './grid';
import type { Issue, Layout, Mission, StationKind, Step } from './types';

/** Station kinds each op is allowed to target. MOVE_TO accepts any station. */
const ALLOWED_KINDS: Record<'PICK' | 'PLACE' | 'CHARGE', readonly StationKind[]> = {
  PICK: ['shelf'],
  PLACE: ['shelf', 'dock'],
  CHARGE: ['charger'],
};

export type HandlingOp = 'PICK' | 'PLACE' | 'CHARGE';

export function allowedKindsFor(op: HandlingOp): readonly StationKind[] {
  return ALLOWED_KINDS[op];
}

export function isKindAllowed(op: HandlingOp, kind: StationKind): boolean {
  return ALLOWED_KINDS[op].includes(kind);
}

export function isValidChargeTarget(toPercent: number): boolean {
  return Number.isFinite(toPercent) && toPercent >= 0 && toPercent <= 100;
}

/** Convenience for callers that only care whether a mission is runnable. */
export function hasBlockingIssues(issues: Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/**
 * Static mission check — no simulation, no battery, no pathfinding.
 *
 * Used in three places: gating LLM output, the live linter in the plan editor,
 * and as unit-test surface. Anything that needs the grid (reachability,
 * battery) belongs in `simulate()`, not here.
 */
export function validateMission(layout: Layout, mission: Mission): Issue[] {
  const issues: Issue[] = [];

  if (mission.steps.length === 0) {
    return [
      {
        stepIndex: null,
        code: 'EMPTY_MISSION',
        message: 'Mission has no steps.',
        severity: 'error',
      },
    ];
  }

  // The gripper is empty at the start of every mission.
  let carrying: string | null = null;

  for (let stepIndex = 0; stepIndex < mission.steps.length; stepIndex += 1) {
    const step = mission.steps[stepIndex];

    if (step.op === 'WAIT') {
      if (!Number.isInteger(step.ticks) || step.ticks <= 0) {
        issues.push({
          stepIndex,
          code: 'INVALID_WAIT',
          message: `WAIT needs a positive whole number of ticks, got ${step.ticks}.`,
          severity: 'error',
        });
      }
      continue;
    }

    const station = findStation(layout, step.stationId);

    if (station === undefined) {
      issues.push({
        stepIndex,
        code: 'UNKNOWN_STATION',
        message: `Step ${stepIndex} references station "${step.stationId}", which is not in this layout.`,
        severity: 'error',
      });
    } else if (step.op !== 'MOVE_TO' && !isKindAllowed(step.op, station.kind)) {
      issues.push({
        stepIndex,
        code: 'WRONG_STATION_KIND',
        message: `Step ${stepIndex} runs ${step.op} at "${station.name}", which is a ${station.kind}.`,
        severity: 'error',
      });
    }

    if (step.op === 'CHARGE' && !isValidChargeTarget(step.toPercent)) {
      issues.push({
        stepIndex,
        code: 'INVALID_CHARGE_TARGET',
        message: `CHARGE target must be between 0 and 100, got ${step.toPercent}.`,
        severity: 'error',
      });
    }

    if (step.op === 'PICK') {
      if (carrying !== null) {
        issues.push({
          stepIndex,
          code: 'GRIPPER_FULL',
          message: `Step ${stepIndex} picks "${step.item}" while already carrying "${carrying}".`,
          severity: 'error',
        });
      } else {
        carrying = step.item;
      }
    }

    if (step.op === 'PLACE') {
      if (carrying === null) {
        issues.push({
          stepIndex,
          code: 'GRIPPER_EMPTY',
          message: `Step ${stepIndex} places "${step.item}" with an empty gripper.`,
          severity: 'error',
        });
      } else {
        carrying = null;
      }
    }
  }

  if (carrying !== null) {
    issues.push({
      stepIndex: mission.steps.length - 1,
      code: 'ENDS_CARRYING',
      message: `Mission ends while still carrying "${carrying}".`,
      severity: 'warning',
    });
  }

  return issues;
}

/** Narrow helper kept next to the rules it belongs to. */
export function describeStep(step: Step): string {
  switch (step.op) {
    case 'MOVE_TO':
      return `MOVE_TO ${step.stationId}`;
    case 'PICK':
      return `PICK ${step.item} at ${step.stationId}`;
    case 'PLACE':
      return `PLACE ${step.item} at ${step.stationId}`;
    case 'WAIT':
      return `WAIT ${step.ticks}`;
    case 'CHARGE':
      return `CHARGE ${step.stationId} to ${step.toPercent}%`;
  }
}
