import type { Cell, Layout } from '../../../src/lib/sim';

/** `cells([0, 1], [0, 2])` — terser than a wall of object literals. */
export function cells(...pairs: Array<[number, number]>): Cell[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

/** An empty grid with no stations. Callers override what they care about. */
export function grid(overrides: Partial<Layout> = {}): Layout {
  return {
    width: 5,
    height: 5,
    obstacles: [],
    stations: [],
    start: { x: 0, y: 0 },
    ...overrides,
  };
}

/**
 * The workhorse layout for executor tests: one row, no obstacles, so every
 * distance is readable straight off the coordinates.
 *
 *   y=0:  [dock]  .  [shelf]  .  [charger]
 */
export function bench(overrides: Partial<Layout> = {}): Layout {
  return grid({
    stations: [
      { id: 'dock-1', name: 'Dock', cell: { x: 0, y: 0 }, kind: 'dock' },
      { id: 'shelf-1', name: 'Shelf', cell: { x: 2, y: 0 }, kind: 'shelf', items: ['bolt', 'nut'] },
      { id: 'charger-1', name: 'Charger', cell: { x: 4, y: 0 }, kind: 'charger' },
    ],
    ...overrides,
  });
}
