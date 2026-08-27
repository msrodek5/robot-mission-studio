import { describe, expect, it } from 'vitest';

import {
  hasBlockingLayoutIssues,
  validateLayout,
  type LayoutIssueCode,
} from '../../../src/lib/layout/validate-layout';
import type { Cell, Layout, Station } from '../../../src/lib/sim';

/**
 * A layout that passes every rule. Each test below breaks exactly one thing, so
 * a failure names the rule that regressed rather than "the fixture is wrong".
 */
function validLayout(overrides: Partial<Layout> = {}): Layout {
  return {
    width: 10,
    height: 10,
    obstacles: [{ x: 5, y: 5 }],
    stations: [station('dock-1', 'Dock A', { x: 1, y: 1 }, 'dock')],
    start: { x: 0, y: 0 },
    ...overrides,
  };
}

function station(id: string, name: string, cell: Cell, kind: Station['kind']): Station {
  return { id, name, cell, kind };
}

function codes(layout: Layout): LayoutIssueCode[] {
  return validateLayout(layout).map((issue) => issue.code);
}

describe('validateLayout', () => {
  it('reports nothing for a valid layout', () => {
    expect(validateLayout(validLayout())).toEqual([]);
  });

  describe('start cell', () => {
    it('flags a start outside the grid', () => {
      expect(codes(validLayout({ start: { x: 10, y: 0 } }))).toContain('START_OUT_OF_BOUNDS');
    });

    it('flags a negative start', () => {
      expect(codes(validLayout({ start: { x: -1, y: 0 } }))).toContain('START_OUT_OF_BOUNDS');
    });

    it('accepts a start on the far corner', () => {
      expect(codes(validLayout({ start: { x: 9, y: 9 } }))).not.toContain('START_OUT_OF_BOUNDS');
    });

    it('flags a start sitting on an obstacle', () => {
      const layout = validLayout({ obstacles: [{ x: 3, y: 3 }], start: { x: 3, y: 3 } });

      expect(codes(layout)).toContain('START_ON_OBSTACLE');
    });
  });

  describe('obstacles', () => {
    it('flags an obstacle outside the grid', () => {
      const layout = validLayout({ obstacles: [{ x: 99, y: 0 }] });

      expect(codes(layout)).toContain('OBSTACLE_OUT_OF_BOUNDS');
    });

    it('reports one issue per out-of-bounds obstacle', () => {
      const layout = validLayout({
        obstacles: [
          { x: 99, y: 0 },
          { x: 0, y: 99 },
        ],
      });

      expect(codes(layout).filter((code) => code === 'OBSTACLE_OUT_OF_BOUNDS')).toHaveLength(2);
    });
  });

  describe('stations', () => {
    it('requires at least one station', () => {
      expect(codes(validLayout({ stations: [] }))).toContain('NO_STATIONS');
    });

    it('flags a station outside the grid', () => {
      const layout = validLayout({
        stations: [station('s1', 'Far', { x: 10, y: 10 }, 'shelf')],
      });

      expect(codes(layout)).toContain('STATION_OUT_OF_BOUNDS');
    });

    it('flags a station on an obstacle', () => {
      const layout = validLayout({
        obstacles: [{ x: 2, y: 2 }],
        stations: [station('s1', 'Blocked', { x: 2, y: 2 }, 'shelf')],
      });

      expect(codes(layout)).toContain('STATION_ON_OBSTACLE');
    });

    it('flags two stations on the same cell', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'First', { x: 4, y: 4 }, 'shelf'),
          station('s2', 'Second', { x: 4, y: 4 }, 'dock'),
        ],
      });

      expect(codes(layout)).toContain('DUPLICATE_STATION_CELL');
    });

    it('blames the second station for a cell clash, not the first', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'First', { x: 4, y: 4 }, 'shelf'),
          station('s2', 'Second', { x: 4, y: 4 }, 'dock'),
        ],
      });

      const clash = validateLayout(layout).find(
        (issue) => issue.code === 'DUPLICATE_STATION_CELL',
      );

      expect(clash?.stationIndex).toBe(1);
    });

    it('allows stations on different cells', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'First', { x: 4, y: 4 }, 'shelf'),
          station('s2', 'Second', { x: 4, y: 5 }, 'dock'),
        ],
      });

      expect(validateLayout(layout)).toEqual([]);
    });
  });

  describe('station names', () => {
    it('flags an empty name', () => {
      const layout = validLayout({ stations: [station('s1', '', { x: 1, y: 1 }, 'dock')] });

      expect(codes(layout)).toContain('EMPTY_STATION_NAME');
    });

    it('flags a whitespace-only name', () => {
      const layout = validLayout({ stations: [station('s1', '   ', { x: 1, y: 1 }, 'dock')] });

      expect(codes(layout)).toContain('EMPTY_STATION_NAME');
    });

    it('flags duplicate names', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'Dock A', { x: 1, y: 1 }, 'dock'),
          station('s2', 'Dock A', { x: 2, y: 2 }, 'dock'),
        ],
      });

      expect(codes(layout)).toContain('DUPLICATE_STATION_NAME');
    });

    it('treats names differing only by case or padding as duplicates', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'Dock A', { x: 1, y: 1 }, 'dock'),
          station('s2', '  dock a  ', { x: 2, y: 2 }, 'dock'),
        ],
      });

      expect(codes(layout)).toContain('DUPLICATE_STATION_NAME');
    });

    it('does not also report a blank name as a duplicate', () => {
      const layout = validLayout({
        stations: [
          station('s1', '', { x: 1, y: 1 }, 'dock'),
          station('s2', '', { x: 2, y: 2 }, 'dock'),
        ],
      });

      const found = codes(layout);

      expect(found.filter((code) => code === 'EMPTY_STATION_NAME')).toHaveLength(2);
      expect(found).not.toContain('DUPLICATE_STATION_NAME');
    });
  });

  describe('reporting', () => {
    it('collects every problem rather than stopping at the first', () => {
      const layout: Layout = {
        width: 5,
        height: 5,
        obstacles: [{ x: 1, y: 1 }],
        stations: [station('s1', '', { x: 1, y: 1 }, 'dock')],
        start: { x: 1, y: 1 },
      };

      expect(new Set(codes(layout))).toEqual(
        new Set(['START_ON_OBSTACLE', 'STATION_ON_OBSTACLE', 'EMPTY_STATION_NAME']),
      );
    });

    it('points a station issue at the offending index and cell', () => {
      const layout = validLayout({
        stations: [
          station('s1', 'Fine', { x: 1, y: 1 }, 'dock'),
          station('s2', 'Far', { x: 42, y: 7 }, 'shelf'),
        ],
      });

      const issue = validateLayout(layout).find(
        (candidate) => candidate.code === 'STATION_OUT_OF_BOUNDS',
      );

      expect(issue?.stationIndex).toBe(1);
      expect(issue?.cell).toEqual({ x: 42, y: 7 });
    });

    it('is pure — repeated calls on the same input agree', () => {
      const layout = validLayout({ start: { x: 99, y: 99 } });

      expect(validateLayout(layout)).toEqual(validateLayout(layout));
    });

    it('does not mutate the layout it is given', () => {
      const layout = validLayout({ stations: [station('s1', '  Padded  ', { x: 1, y: 1 }, 'dock')] });
      const before = structuredClone(layout);

      validateLayout(layout);

      expect(layout).toEqual(before);
    });
  });

  describe('hasBlockingLayoutIssues', () => {
    it('is false for a clean layout', () => {
      expect(hasBlockingLayoutIssues(validateLayout(validLayout()))).toBe(false);
    });

    it('is true when an error is present', () => {
      expect(hasBlockingLayoutIssues(validateLayout(validLayout({ stations: [] })))).toBe(true);
    });
  });
});
