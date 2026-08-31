import { findStation } from '../../lib/sim';
import type { Layout, Step } from '../../lib/sim';

/**
 * Steps as a person reads them: station names, not ids.
 *
 * `describeStep` in the sim core prints ids, which is right for a log line and
 * wrong for a panel the user is watching. An id with no matching station is shown
 * verbatim — that is a real plan the simulator will fail with `UNKNOWN_STATION`,
 * and hiding it would make the failure unexplainable.
 *
 * Shared by the playback step list and the postmortem's suggested edits, so the
 * two never describe the same step differently on the same screen.
 */
export function stepLabel(step: Step, layout: Layout): string {
  if (step.op === 'WAIT') return `WAIT ${step.ticks} tick(s)`;

  const station = findStation(layout, step.stationId);
  const where = station ? station.name || 'unnamed' : `${step.stationId} (unknown)`;

  switch (step.op) {
    case 'MOVE_TO':
      return `MOVE_TO ${where}`;
    case 'PICK':
      return `PICK “${step.item}” at ${where}`;
    case 'PLACE':
      return `PLACE “${step.item}” at ${where}`;
    case 'CHARGE':
      return `CHARGE at ${where} to ${step.toPercent}%`;
  }
}
