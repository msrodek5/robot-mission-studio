import { describe, expect, it } from 'vitest';

import {
  isClipEmpty,
  previewClip,
  resizeLayout,
} from '../../../src/lib/layout/resize-layout';
import type { Layout } from '../../../src/lib/sim';

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    width: 10,
    height: 10,
    obstacles: [
      { x: 1, y: 1 },
      { x: 8, y: 8 },
    ],
    stations: [
      { id: 's1', name: 'Near', cell: { x: 2, y: 2 }, kind: 'dock' },
      { id: 's2', name: 'Far', cell: { x: 9, y: 9 }, kind: 'shelf' },
    ],
    start: { x: 0, y: 0 },
    ...overrides,
  };
}

describe('previewClip', () => {
  it('reports nothing when growing the grid', () => {
    const preview = previewClip(layout(), 20, 20);

    expect(isClipEmpty(preview)).toBe(true);
  });

  it('reports nothing when the size is unchanged', () => {
    expect(isClipEmpty(previewClip(layout(), 10, 10))).toBe(true);
  });

  it('names the obstacles and stations that would be lost', () => {
    const preview = previewClip(layout(), 5, 5);

    expect(preview.obstacles).toEqual([{ x: 8, y: 8 }]);
    expect(preview.stations.map((station) => station.name)).toEqual(['Far']);
  });

  it('flags a start cell that would fall outside', () => {
    const preview = previewClip(layout({ start: { x: 9, y: 9 } }), 5, 5);

    expect(preview.movesStart).toBe(true);
  });

  it('leaves the layout untouched', () => {
    const original = layout();
    const before = structuredClone(original);

    previewClip(original, 5, 5);

    expect(original).toEqual(before);
  });

  it('agrees with what resizeLayout actually drops', () => {
    // The warning must not be able to promise one thing and the resize do
    // another; that is how a user loses work they were told was safe.
    const original = layout();
    const preview = previewClip(original, 5, 5);
    const resized = resizeLayout(original, 5, 5);

    expect(resized.obstacles).toHaveLength(original.obstacles.length - preview.obstacles.length);
    expect(resized.stations).toHaveLength(original.stations.length - preview.stations.length);
  });
});

describe('resizeLayout', () => {
  it('keeps everything that still fits', () => {
    const resized = resizeLayout(layout(), 5, 5);

    expect(resized.obstacles).toEqual([{ x: 1, y: 1 }]);
    expect(resized.stations.map((station) => station.id)).toEqual(['s1']);
  });

  it('applies the new dimensions', () => {
    const resized = resizeLayout(layout(), 7, 6);

    expect(resized.width).toBe(7);
    expect(resized.height).toBe(6);
  });

  it('clamps a stranded start cell to the nearest corner', () => {
    const resized = resizeLayout(layout({ start: { x: 9, y: 9 } }), 5, 5);

    expect(resized.start).toEqual({ x: 4, y: 4 });
  });

  it('leaves an in-bounds start alone', () => {
    const resized = resizeLayout(layout({ start: { x: 3, y: 2 } }), 5, 5);

    expect(resized.start).toEqual({ x: 3, y: 2 });
  });

  it('clips only on the shrinking axis', () => {
    const resized = resizeLayout(layout(), 10, 5);

    // (8,8) fails on y only; (1,1) survives both.
    expect(resized.obstacles).toEqual([{ x: 1, y: 1 }]);
  });

  it('does not mutate the input', () => {
    const original = layout();
    const before = structuredClone(original);

    resizeLayout(original, 5, 5);

    expect(original).toEqual(before);
  });

  it('is idempotent when nothing is out of bounds', () => {
    const original = layout({ obstacles: [], stations: [], start: { x: 0, y: 0 } });

    expect(resizeLayout(original, 10, 10)).toEqual(original);
  });
});
