/**
 * Static layout check — the editor's live linter and the server's gate.
 *
 * Pure: same input, same output, no clock and no I/O. It runs in the browser on
 * every keystroke and again in the POST/PUT handlers, because a client-side
 * check is a convenience, never a control.
 *
 * A layout with issues is still savable as a draft. Nothing here throws; the
 * caller decides what a non-empty result means.
 */

import { cellKey, inBounds } from '../sim';
import type { Cell, Layout } from '../sim';

export type LayoutIssueCode =
  | 'START_OUT_OF_BOUNDS'
  | 'START_ON_OBSTACLE'
  | 'NO_STATIONS'
  | 'OBSTACLE_OUT_OF_BOUNDS'
  | 'STATION_OUT_OF_BOUNDS'
  | 'STATION_ON_OBSTACLE'
  | 'DUPLICATE_STATION_CELL'
  | 'EMPTY_STATION_NAME'
  | 'DUPLICATE_STATION_NAME';

/**
 * Mirrors the sim module's `Issue` — a locator, a code, a human message, and a
 * severity — but carries its own code union and points at a station or a cell
 * rather than a step index.
 *
 * It is a separate type rather than a reuse of `Issue` because widening
 * `IssueCode` would mean editing `src/lib/sim/types.ts`, and the sim core is not
 * in this milestone's scope.
 */
export type LayoutIssue = {
  /** Index into `layout.stations`, or `null` for whole-layout issues. */
  stationIndex: number | null;
  /** The offending square, when the issue is about one. */
  cell: Cell | null;
  code: LayoutIssueCode;
  message: string;
  severity: 'error' | 'warning';
};

/** Convenience for callers that only care whether anything is wrong. */
export function hasBlockingLayoutIssues(issues: LayoutIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function validateLayout(layout: Layout): LayoutIssue[] {
  const issues: LayoutIssue[] = [];

  const obstacles = new Set(layout.obstacles.map(cellKey));

  // --- start cell -----------------------------------------------------------

  if (!inBounds(layout, layout.start)) {
    issues.push({
      stationIndex: null,
      cell: layout.start,
      code: 'START_OUT_OF_BOUNDS',
      message: `Start cell (${layout.start.x}, ${layout.start.y}) is outside the ${layout.width}x${layout.height} grid.`,
      severity: 'error',
    });
  }

  if (obstacles.has(cellKey(layout.start))) {
    issues.push({
      stationIndex: null,
      cell: layout.start,
      code: 'START_ON_OBSTACLE',
      message: `Start cell (${layout.start.x}, ${layout.start.y}) sits on an obstacle.`,
      severity: 'error',
    });
  }

  // --- obstacles ------------------------------------------------------------

  for (const cell of layout.obstacles) {
    if (!inBounds(layout, cell)) {
      issues.push({
        stationIndex: null,
        cell,
        code: 'OBSTACLE_OUT_OF_BOUNDS',
        message: `Obstacle at (${cell.x}, ${cell.y}) is outside the ${layout.width}x${layout.height} grid.`,
        severity: 'error',
      });
    }
  }

  // --- stations -------------------------------------------------------------

  if (layout.stations.length === 0) {
    issues.push({
      stationIndex: null,
      cell: null,
      code: 'NO_STATIONS',
      message: 'Layout has no stations. A mission needs somewhere to go.',
      severity: 'error',
    });
  }

  // First index each cell and name was seen, so the *duplicate* is reported and
  // the original is left alone. Reporting both would double-count every clash.
  const cellFirstSeen = new Map<string, number>();
  const nameFirstSeen = new Map<string, number>();

  for (const [stationIndex, station] of layout.stations.entries()) {
    const { cell, name } = station;
    const label = describeStation(station.name, stationIndex);

    if (!inBounds(layout, cell)) {
      issues.push({
        stationIndex,
        cell,
        code: 'STATION_OUT_OF_BOUNDS',
        message: `${label} is at (${cell.x}, ${cell.y}), outside the ${layout.width}x${layout.height} grid.`,
        severity: 'error',
      });
    }

    if (obstacles.has(cellKey(cell))) {
      issues.push({
        stationIndex,
        cell,
        code: 'STATION_ON_OBSTACLE',
        message: `${label} sits on an obstacle at (${cell.x}, ${cell.y}).`,
        severity: 'error',
      });
    }

    const key = cellKey(cell);
    const cellClash = cellFirstSeen.get(key);

    if (cellClash === undefined) {
      cellFirstSeen.set(key, stationIndex);
    } else {
      issues.push({
        stationIndex,
        cell,
        code: 'DUPLICATE_STATION_CELL',
        message: `${label} shares cell (${cell.x}, ${cell.y}) with ${describeStation(
          layout.stations[cellClash].name,
          cellClash,
        )}.`,
        severity: 'error',
      });
    }

    if (name.trim() === '') {
      issues.push({
        stationIndex,
        cell,
        code: 'EMPTY_STATION_NAME',
        message: `Station ${stationIndex + 1} has no name.`,
        severity: 'error',
      });
      // An unnamed station cannot also be a duplicate name; skip the check so
      // two blank names report one problem each rather than two.
      continue;
    }

    // Names are matched case-insensitively: "Dock A" and "dock a" would be a
    // coin-flip to tell apart in a station dropdown.
    const nameKey = name.trim().toLowerCase();
    const nameClash = nameFirstSeen.get(nameKey);

    if (nameClash === undefined) {
      nameFirstSeen.set(nameKey, stationIndex);
    } else {
      issues.push({
        stationIndex,
        cell,
        code: 'DUPLICATE_STATION_NAME',
        message: `Station name "${name.trim()}" is used by station ${nameClash + 1} and station ${
          stationIndex + 1
        }.`,
        severity: 'error',
      });
    }
  }

  return issues;
}

function describeStation(name: string, index: number): string {
  const trimmed = name.trim();

  return trimmed === '' ? `Station ${index + 1}` : `"${trimmed}"`;
}
