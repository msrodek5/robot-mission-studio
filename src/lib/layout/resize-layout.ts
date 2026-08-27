/**
 * Grid resizing.
 *
 * Shrinking a grid can strand obstacles, stations, and the start cell outside
 * the new bounds. Rather than leave invalid coordinates in the layout, the
 * resize drops what no longer fits — and reports what it would drop first, so
 * the editor can warn before anything is lost.
 *
 * Pure, and separate from the React component so the clipping rules can be
 * tested without rendering anything.
 */

import { inBounds } from '../sim';
import type { Cell, Layout, Station } from '../sim';

export type ClipPreview = {
  obstacles: Cell[];
  stations: Station[];
  /** True when the start cell would fall outside and be pulled back in. */
  movesStart: boolean;
};

export function isClipEmpty(preview: ClipPreview): boolean {
  return (
    preview.obstacles.length === 0 && preview.stations.length === 0 && !preview.movesStart
  );
}

/** What a resize to `width` x `height` would discard. Changes nothing. */
export function previewClip(layout: Layout, width: number, height: number): ClipPreview {
  const bounds = { ...layout, width, height };

  return {
    obstacles: layout.obstacles.filter((cell) => !inBounds(bounds, cell)),
    stations: layout.stations.filter((station) => !inBounds(bounds, station.cell)),
    movesStart: !inBounds(bounds, layout.start),
  };
}

/**
 * Applies the resize, dropping anything outside the new bounds.
 *
 * The start cell is clamped rather than dropped — a layout has to have one, and
 * moving it to the nearest in-bounds square loses less than resetting it to the
 * origin would.
 */
export function resizeLayout(layout: Layout, width: number, height: number): Layout {
  const bounds = { ...layout, width, height };

  return {
    width,
    height,
    obstacles: layout.obstacles.filter((cell) => inBounds(bounds, cell)),
    stations: layout.stations.filter((station) => inBounds(bounds, station.cell)),
    start: clampCell(layout.start, width, height),
  };
}

function clampCell(cell: Cell, width: number, height: number): Cell {
  return {
    x: Math.min(Math.max(cell.x, 0), width - 1),
    y: Math.min(Math.max(cell.y, 0), height - 1),
  };
}
