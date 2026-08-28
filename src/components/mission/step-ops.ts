import type { StepInput } from '../../lib/schemas/mission';
import { allowedKindsFor } from '../../lib/sim';
import type { Layout, Station, StepOp } from '../../lib/sim';

/** Order the op dropdown offers. Movement first, then handling, then idling. */
export const STEP_OPS: readonly StepOp[] = ['MOVE_TO', 'PICK', 'PLACE', 'CHARGE', 'WAIT'] as const;

/**
 * The station a new step should start on.
 *
 * Picks one of the *right kind* where the op has one — a fresh CHARGE step
 * pointing at a shelf would be an issue the user did not create and has to
 * clear before doing anything useful. Falls back to the first station, and the
 * linter takes it from there when the layout has nothing suitable.
 */
export function defaultStationId(layout: Layout, op: StepOp): string {
  const first = layout.stations[0];

  if (first === undefined) return '';
  if (op === 'MOVE_TO' || op === 'WAIT') return first.id;

  const allowed = allowedKindsFor(op);
  const match = layout.stations.find((station) => allowed.includes(station.kind));

  return (match ?? first).id;
}

/** A newly added step, valid-by-construction as far as the layout allows. */
export function defaultStep(layout: Layout, op: StepOp): StepInput {
  const stationId = defaultStationId(layout, op);

  switch (op) {
    case 'MOVE_TO':
      return { op, stationId };
    case 'PICK':
      return { op, stationId, item: 'crate' };
    case 'PLACE':
      return { op, stationId, item: 'crate' };
    case 'CHARGE':
      return { op, stationId, toPercent: 80 };
    case 'WAIT':
      return { op, ticks: 1 };
  }
}

/**
 * Switches a step to another op, carrying across what still applies.
 *
 * Changing MOVE_TO to PICK should keep the station the user already chose;
 * changing PICK to PLACE should keep the item. Rebuilding from scratch every
 * time would silently discard both.
 */
export function withOp(step: StepInput, op: StepOp, layout: Layout): StepInput {
  if (step.op === op) return step;

  const carriedStation = 'stationId' in step ? step.stationId : defaultStationId(layout, op);
  const carriedItem = 'item' in step ? step.item : 'crate';

  switch (op) {
    case 'MOVE_TO':
      return { op, stationId: carriedStation };
    case 'PICK':
      return { op, stationId: carriedStation, item: carriedItem };
    case 'PLACE':
      return { op, stationId: carriedStation, item: carriedItem };
    case 'CHARGE':
      return { op, stationId: carriedStation, toPercent: 80 };
    case 'WAIT':
      return { op, ticks: 1 };
  }
}

/**
 * Moves a step by one position.
 *
 * Returns the same array reference when the move would run off either end, so
 * the caller's dirty flag is not tripped by a no-op click.
 */
export function moveStep(steps: StepInput[], index: number, delta: -1 | 1): StepInput[] {
  const target = index + delta;

  if (target < 0 || target >= steps.length) return steps;

  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);

  return next;
}

/** `Dock (dock)` — the kind is shown because the linter cares about it. */
export function stationLabel(station: Station): string {
  const name = station.name.trim();

  return `${name.length === 0 ? station.id : name} (${station.kind})`;
}
