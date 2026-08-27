/**
 * Zod schemas for layouts.
 *
 * These live here rather than in `src/lib/sim` because the sim core takes no
 * dependencies, ever (CLAUDE.md rule 1). The sim owns the *types*; this module
 * owns the *parsing* of untrusted input into those types, and a compile-time
 * assertion at the bottom stops the two drifting apart.
 */

import { z } from 'zod';

import type { Layout } from '../sim';

/**
 * Grid bounds accepted by the editor.
 *
 * Narrower than the 5..30 the simulator and the `layouts` check constraint
 * allow — M3 ships a 5..20 editor. Widening is a one-line change here because
 * the schema and the number inputs both read these constants.
 */
export const GRID_MIN = 5;
export const GRID_MAX = 20;

export const DEFAULT_WIDTH = 10;
export const DEFAULT_HEIGHT = 10;

export const STATION_KINDS = ['dock', 'shelf', 'charger'] as const;

export const CellSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export const StationKindSchema = z.enum(STATION_KINDS);

export const StationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  cell: CellSchema,
  kind: StationKindSchema,
  /**
   * Items present at the start of a run. The editor never sets this in M3, but
   * it round-trips so a layout saved by a later milestone is not silently
   * stripped on the next save.
   */
  items: z.array(z.string()).optional(),
});

/** The shape stored in the `layouts.grid` jsonb column. */
export const LayoutGridSchema = z.object({
  obstacles: z.array(CellSchema),
  stations: z.array(StationSchema),
  start: CellSchema,
});

/** A full layout: the grid payload plus the dimensions held in real columns. */
export const LayoutSchema = LayoutGridSchema.extend({
  width: z.number().int().min(GRID_MIN).max(GRID_MAX),
  height: z.number().int().min(GRID_MIN).max(GRID_MAX),
});

export const LayoutNameSchema = z.string().trim().min(1).max(120);

/** POST /api/layouts — name only; the grid starts empty and valid-ish. */
export const CreateLayoutSchema = z.object({
  name: LayoutNameSchema,
});

/**
 * PUT /api/layouts/[id].
 *
 * `user_id` is deliberately absent and would be stripped even if sent: ownership
 * comes from the session, never from the request body.
 */
export const UpdateLayoutSchema = z.object({
  name: LayoutNameSchema,
  layout: LayoutSchema,
});

/** What the API hands back to the browser. */
export const LayoutRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  layout: LayoutSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CellInput = z.infer<typeof CellSchema>;
export type StationInput = z.infer<typeof StationSchema>;
export type LayoutInput = z.infer<typeof LayoutSchema>;
export type CreateLayoutInput = z.infer<typeof CreateLayoutSchema>;
export type UpdateLayoutInput = z.infer<typeof UpdateLayoutSchema>;
export type LayoutRecord = z.infer<typeof LayoutRecordSchema>;

/**
 * Drift guard.
 *
 * If someone edits `Layout` in the sim core or loosens a field here, one of
 * these stops compiling. That is the whole point: the schema is the parser for
 * the sim's type, so a silent divergence would mean the API accepts something
 * `simulate()` cannot run.
 */
type Expect<T extends true> = T;

export type LayoutSchemaMatchesSim = Expect<LayoutInput extends Layout ? true : false>;
export type SimLayoutMatchesSchema = Expect<Layout extends LayoutInput ? true : false>;

/** A brand-new layout: empty grid, start in the top-left corner. */
export function emptyLayout(): LayoutInput {
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    obstacles: [],
    stations: [],
    start: { x: 0, y: 0 },
  };
}
