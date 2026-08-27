/**
 * Shared plumbing for the `/api/layouts` endpoints: row mapping, JSON
 * responses, and the session check.
 *
 * The ownership rule lives here so it is stated once. `user_id` is read from the
 * verified session on every path and never from a request body — row-level
 * security is the backstop, not the mechanism.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';

import { LayoutGridSchema, LayoutSchema, type LayoutRecord } from '../schemas/layout';
import { validateLayout, type LayoutIssue } from './validate-layout';

/** Columns every handler selects. Kept in one place so the shapes agree. */
export const LAYOUT_COLUMNS = 'id, name, width, height, grid, created_at, updated_at';

/**
 * A row as it comes back from PostgREST. `grid` is `unknown` on purpose: it is
 * jsonb, so nothing about its contents is guaranteed by the database beyond
 * being an object, and it gets parsed rather than trusted.
 */
const LayoutRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  grid: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type LayoutRow = z.infer<typeof LayoutRowSchema>;

/**
 * Turns a database row into the record the browser sees.
 *
 * A row whose `grid` predates a schema change, or was written by hand, would
 * otherwise crash the editor on load. Falling back to an empty grid keeps the
 * layout openable and lets `validateLayout` explain what is wrong, which beats a
 * blank page.
 */
export function toLayoutRecord(row: LayoutRow): LayoutRecord {
  const grid = LayoutGridSchema.safeParse(row.grid);

  const layout = LayoutSchema.parse({
    width: row.width,
    height: row.height,
    obstacles: grid.success ? grid.data.obstacles : [],
    stations: grid.success ? grid.data.stations : [],
    start: grid.success ? grid.data.start : { x: 0, y: 0 },
  });

  return {
    id: row.id,
    name: row.name,
    layout,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseLayoutRow(row: unknown): LayoutRow {
  return LayoutRowSchema.parse(row);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Layout data is per-user. A shared cache must never hold it.
      'cache-control': 'private, no-store',
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** `undefined` when the body is absent or not JSON, so handlers can 400 it. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * The only 404 helper. A layout owned by someone else is indistinguishable from
 * one that does not exist — returning 403 would confirm the id is real and hand
 * out a way to enumerate other users' layouts.
 */
export function notFound(): Response {
  return errorResponse(404, 'Layout not found.');
}

export function unauthorized(): Response {
  return errorResponse(401, 'Not signed in.');
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type Session = { supabase: SupabaseClient; user: User };

/**
 * `src/middleware.ts` gates `/app/*` but not `/api/*`, so every handler checks
 * for itself. Returning `null` rather than throwing keeps the handlers' happy
 * path flat.
 */
export function requireSession(locals: App.Locals): Session | null {
  if (!locals.user) return null;

  return { supabase: locals.supabase, user: locals.user };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const UuidSchema = z.uuid();

/**
 * Ids are uuids. A malformed one is reported as "not found" rather than "bad
 * request": it cannot name a real row, and Postgres would otherwise raise
 * `invalid input syntax for type uuid` on the query.
 */
export function isLayoutId(id: string | undefined): id is string {
  return UuidSchema.safeParse(id).success;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Server-side re-run of the editor's linter.
 *
 * Issues do not block the write — a draft with problems is explicitly savable —
 * so they ride along in the response for the client to surface.
 */
export function layoutIssuesFor(record: LayoutRecord): LayoutIssue[] {
  return validateLayout(record.layout);
}
