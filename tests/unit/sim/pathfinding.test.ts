import { describe, expect, it } from 'vitest';

import { findPath } from '../../../src/lib/sim';
import { cells, grid } from './layouts';

describe('findPath — reachability', () => {
  it('walks a straight line across an empty grid', () => {
    const path = findPath(grid(), { x: 0, y: 0 }, { x: 4, y: 0 });

    expect(path).toEqual(cells([0, 0], [1, 0], [2, 0], [3, 0], [4, 0]));
  });

  it('returns a single cell when start and goal are the same', () => {
    const path = findPath(grid(), { x: 2, y: 2 }, { x: 2, y: 2 });

    expect(path).toEqual(cells([2, 2]));
  });

  it('routes around a wall at the shortest cost', () => {
    // A wall on x=3 covering y=0..3 forces the detour down to y=4.
    const layout = grid({
      width: 8,
      height: 6,
      obstacles: cells([3, 0], [3, 1], [3, 2], [3, 3]),
    });

    const path = findPath(layout, { x: 0, y: 0 }, { x: 6, y: 1 });

    // 6 across + 4 down + 3 back up = 13 moves, so 14 cells including the start.
    expect(path).not.toBeNull();
    expect(path).toHaveLength(14);
    expect(path?.some((cell) => cell.x === 3 && cell.y <= 3)).toBe(false);
  });

  it('returns null when the goal is walled off', () => {
    const layout = grid({
      obstacles: cells([3, 0], [3, 1], [3, 2], [3, 3], [3, 4]),
    });

    expect(findPath(layout, { x: 0, y: 0 }, { x: 4, y: 2 })).toBeNull();
  });

  it('returns null when the start is walled in', () => {
    const layout = grid({
      // (0,0) is a corner, so two obstacles are enough to seal it.
      obstacles: cells([1, 0], [0, 1]),
      start: { x: 0, y: 0 },
    });

    expect(findPath(layout, { x: 0, y: 0 }, { x: 4, y: 4 })).toBeNull();
  });

  it('returns null when the goal cell is itself an obstacle', () => {
    const layout = grid({ obstacles: cells([2, 2]) });

    expect(findPath(layout, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it('returns null for an out-of-bounds goal', () => {
    expect(findPath(grid(), { x: 0, y: 0 }, { x: 5, y: 0 })).toBeNull();
    expect(findPath(grid(), { x: 0, y: 0 }, { x: -1, y: 0 })).toBeNull();
  });
});

describe('findPath — tie-break determinism', () => {
  it('picks the same optimal path every time ties appear', () => {
    // (0,0) -> (2,2) on an open grid has six shortest paths. The (f, h, x, y)
    // ordering settles it: lowest x first, which walks down the left edge
    // before crossing. If this assertion ever flakes, the tie-break is gone.
    const path = findPath(grid(), { x: 0, y: 0 }, { x: 2, y: 2 });

    expect(path).toEqual(cells([0, 0], [0, 1], [0, 2], [1, 2], [2, 2]));
  });

  it('is stable across repeated calls', () => {
    const layout = grid({ width: 10, height: 10, obstacles: cells([4, 4], [4, 5], [5, 4]) });

    const first = findPath(layout, { x: 0, y: 0 }, { x: 9, y: 9 });
    const runs = Array.from({ length: 10 }, () =>
      findPath(layout, { x: 0, y: 0 }, { x: 9, y: 9 }),
    );

    for (const run of runs) {
      expect(run).toEqual(first);
    }
  });

  it('ignores the ordering of the obstacle list', () => {
    const obstacles = cells([4, 4], [4, 5], [5, 4], [2, 7], [7, 2]);
    const forwards = grid({ width: 10, height: 10, obstacles });
    const backwards = grid({ width: 10, height: 10, obstacles: [...obstacles].reverse() });

    expect(findPath(forwards, { x: 0, y: 0 }, { x: 9, y: 9 })).toEqual(
      findPath(backwards, { x: 0, y: 0 }, { x: 9, y: 9 }),
    );
  });
});
