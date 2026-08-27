import { describe, expect, it } from 'vitest';

import {
  CreateLayoutSchema,
  GRID_MAX,
  GRID_MIN,
  LayoutSchema,
  StationSchema,
  UpdateLayoutSchema,
  emptyLayout,
} from '../../../src/lib/schemas/layout';

// The schemas are the only thing standing between a request body and a `Layout`
// the simulator will later be handed, so the parsing rules get the same
// treatment as the validation rules.
describe('LayoutSchema', () => {
  it('accepts the default empty layout', () => {
    expect(LayoutSchema.safeParse(emptyLayout()).success).toBe(true);
  });

  it('accepts the bounds at both ends', () => {
    for (const size of [GRID_MIN, GRID_MAX]) {
      const result = LayoutSchema.safeParse({ ...emptyLayout(), width: size, height: size });

      expect(result.success).toBe(true);
    }
  });

  it.each([
    ['below the minimum', GRID_MIN - 1],
    ['above the maximum', GRID_MAX + 1],
  ])('rejects a width %s', (_label, width) => {
    expect(LayoutSchema.safeParse({ ...emptyLayout(), width }).success).toBe(false);
  });

  it('rejects a fractional dimension', () => {
    expect(LayoutSchema.safeParse({ ...emptyLayout(), width: 10.5 }).success).toBe(false);
  });

  it('rejects a fractional cell coordinate', () => {
    const layout = { ...emptyLayout(), start: { x: 1.5, y: 0 } };

    expect(LayoutSchema.safeParse(layout).success).toBe(false);
  });

  it('rejects a negative cell coordinate', () => {
    const layout = { ...emptyLayout(), start: { x: -1, y: 0 } };

    expect(LayoutSchema.safeParse(layout).success).toBe(false);
  });

  it('rejects a missing start cell', () => {
    const { start: _start, ...withoutStart } = emptyLayout();

    expect(LayoutSchema.safeParse(withoutStart).success).toBe(false);
  });

  it('strips unknown keys rather than preserving them', () => {
    const result = LayoutSchema.parse({ ...emptyLayout(), sneaky: 'value' });

    expect(result).not.toHaveProperty('sneaky');
  });
});

describe('StationSchema', () => {
  it('accepts each valid kind', () => {
    for (const kind of ['dock', 'shelf', 'charger']) {
      const station = { id: 's1', name: 'A', cell: { x: 0, y: 0 }, kind };

      expect(StationSchema.safeParse(station).success).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    const station = { id: 's1', name: 'A', cell: { x: 0, y: 0 }, kind: 'charging-pad' };

    expect(StationSchema.safeParse(station).success).toBe(false);
  });

  it('rejects an empty id', () => {
    const station = { id: '', name: 'A', cell: { x: 0, y: 0 }, kind: 'dock' };

    expect(StationSchema.safeParse(station).success).toBe(false);
  });

  it('round-trips the optional items list', () => {
    const station = { id: 's1', name: 'A', cell: { x: 0, y: 0 }, kind: 'shelf', items: ['box'] };

    expect(StationSchema.parse(station).items).toEqual(['box']);
  });

  it('allows a blank name, leaving that to validateLayout', () => {
    // Parsing and validation are deliberately separate: a half-finished station
    // must survive a draft save so the editor can show the issue.
    const station = { id: 's1', name: '', cell: { x: 0, y: 0 }, kind: 'dock' };

    expect(StationSchema.safeParse(station).success).toBe(true);
  });
});

describe('request schemas', () => {
  it('trims a create name', () => {
    expect(CreateLayoutSchema.parse({ name: '  Warehouse  ' }).name).toBe('Warehouse');
  });

  it('rejects a blank create name', () => {
    expect(CreateLayoutSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('drops user_id from an update body', () => {
    // Ownership comes from the session. Even if a caller sends one, it must not
    // survive parsing into anything the handler could accidentally use.
    const parsed = UpdateLayoutSchema.parse({
      name: 'Mine',
      layout: emptyLayout(),
      user_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(parsed).not.toHaveProperty('user_id');
  });

  it('rejects an update whose layout is malformed', () => {
    const result = UpdateLayoutSchema.safeParse({ name: 'Mine', layout: { width: 10 } });

    expect(result.success).toBe(false);
  });
});
