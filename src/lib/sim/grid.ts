import type { Cell, Layout, Station } from './types';

/** Stable string key for a cell. Only ever used for Set/Map lookups. */
export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function inBounds(layout: Layout, cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < layout.width && cell.y < layout.height;
}

/**
 * Obstacle lookup set. Built once per pathfinding call so a duplicated or
 * reordered `obstacles` array can never change the result.
 */
export function obstacleSet(layout: Layout): Set<string> {
  const blocked = new Set<string>();
  for (const cell of layout.obstacles) {
    blocked.add(cellKey(cell));
  }
  return blocked;
}

export function isWalkable(layout: Layout, blocked: Set<string>, cell: Cell): boolean {
  return inBounds(layout, cell) && !blocked.has(cellKey(cell));
}

export function findStation(layout: Layout, stationId: string): Station | undefined {
  return layout.stations.find((station) => station.id === stationId);
}
