/**
 * GET  /api/layouts — the signed-in user's layouts, newest first.
 * POST /api/layouts — create a named, empty layout.
 */

import type { APIRoute } from 'astro';

import {
  LAYOUT_COLUMNS,
  errorResponse,
  json,
  layoutIssuesFor,
  parseLayoutRow,
  readJson,
  requireSession,
  toLayoutRecord,
  unauthorized,
} from '../../../lib/layout/layout-api';
import { CreateLayoutSchema, emptyLayout } from '../../../lib/schemas/layout';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  // No `.eq('user_id', ...)` needed — the select policy already scopes this to
  // the caller. Adding one would imply RLS were optional.
  const { data, error } = await session.supabase
    .from('layouts')
    .select(LAYOUT_COLUMNS)
    .order('updated_at', { ascending: false });

  if (error) return errorResponse(500, error.message);

  const layouts = (data ?? []).map((row) => toLayoutRecord(parseLayoutRow(row)));

  return json({ layouts });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = CreateLayoutSchema.safeParse(body);
  if (!parsed.success) return errorResponse(400, 'A layout needs a name.');

  const layout = emptyLayout();

  const { data, error } = await session.supabase
    .from('layouts')
    .insert({
      // From the verified session, never the request body.
      user_id: session.user.id,
      name: parsed.data.name,
      width: layout.width,
      height: layout.height,
      grid: { obstacles: layout.obstacles, stations: layout.stations, start: layout.start },
    })
    .select(LAYOUT_COLUMNS)
    .single();

  if (error) return errorResponse(500, error.message);

  const record = toLayoutRecord(parseLayoutRow(data));

  return json({ layout: record, issues: layoutIssuesFor(record) }, 201);
};
