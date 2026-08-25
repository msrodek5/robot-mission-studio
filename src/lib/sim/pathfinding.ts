import { cellKey, inBounds, isWalkable, manhattan, obstacleSet, sameCell } from './grid';
import type { Cell, Layout } from './types';

type Node = {
  cell: Cell;
  g: number;
  h: number;
  f: number;
};

/**
 * Fixed neighbour order (up, right, down, left). 4-neighbour grid only —
 * diagonals are out of scope.
 */
const NEIGHBOURS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Deterministic ordering of the open set: `(f, h, x, y)`.
 *
 * The `f` and `h` terms are the usual A* ordering; `x` and `y` are the part
 * that matters. Without them two equal-cost frontier nodes are separated only
 * by insertion order, and every golden test becomes a coin flip.
 */
function compareNodes(a: Node, b: Node): number {
  if (a.f !== b.f) return a.f - b.f;
  if (a.h !== b.h) return a.h - b.h;
  if (a.cell.x !== b.cell.x) return a.cell.x - b.cell.x;
  return a.cell.y - b.cell.y;
}

/**
 * A* over the 4-neighbour grid with a Manhattan heuristic.
 *
 * Returns the full path including both endpoints, or `null` when no path
 * exists (walled-in start, walled-off target, target on an obstacle, or either
 * endpoint out of bounds).
 */
export function findPath(layout: Layout, from: Cell, to: Cell): Cell[] | null {
  const blocked = obstacleSet(layout);

  if (!isWalkable(layout, blocked, from)) return null;
  if (!isWalkable(layout, blocked, to)) return null;
  if (sameCell(from, to)) return [{ x: from.x, y: from.y }];

  const open: Node[] = [{ cell: from, g: 0, h: manhattan(from, to), f: manhattan(from, to) }];
  const bestG = new Map<string, number>([[cellKey(from), 0]]);
  const cameFrom = new Map<string, Cell>();
  const closed = new Set<string>();

  while (open.length > 0) {
    // Linear scan rather than a heap: the grid caps at 30x30, and a scan makes
    // the tie-break rule obvious instead of hiding it in sift-down order.
    let bestIndex = 0;
    for (let i = 1; i < open.length; i += 1) {
      if (compareNodes(open[i], open[bestIndex]) < 0) bestIndex = i;
    }
    const current = open[bestIndex];
    open.splice(bestIndex, 1);

    const currentKey = cellKey(current.cell);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);

    if (sameCell(current.cell, to)) {
      return reconstruct(cameFrom, current.cell);
    }

    for (const offset of NEIGHBOURS) {
      const next: Cell = { x: current.cell.x + offset.x, y: current.cell.y + offset.y };
      const nextKey = cellKey(next);
      if (closed.has(nextKey)) continue;
      if (!inBounds(layout, next) || blocked.has(nextKey)) continue;

      const tentativeG = current.g + 1;
      const known = bestG.get(nextKey);
      // Strictly better only: on a tie the first predecessor wins, which is
      // deterministic because the pop order above is.
      if (known !== undefined && tentativeG >= known) continue;

      bestG.set(nextKey, tentativeG);
      cameFrom.set(nextKey, current.cell);
      const h = manhattan(next, to);
      open.push({ cell: next, g: tentativeG, h, f: tentativeG + h });
    }
  }

  return null;
}

function reconstruct(cameFrom: Map<string, Cell>, goal: Cell): Cell[] {
  const path: Cell[] = [{ x: goal.x, y: goal.y }];
  let cursor: Cell | undefined = cameFrom.get(cellKey(goal));
  while (cursor !== undefined) {
    path.push({ x: cursor.x, y: cursor.y });
    cursor = cameFrom.get(cellKey(cursor));
  }
  return path.reverse();
}
