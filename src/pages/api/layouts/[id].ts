/**
 * GET    /api/layouts/:id — read one layout.
 * PUT    /api/layouts/:id — save the editor's state.
 * DELETE /api/layouts/:id — remove it.
 *
 * Every path returns 404 for a layout the caller does not own. Row-level
 * security makes another user's row invisible, so "not mine" and "not there"
 * arrive here as the same empty result — and they leave as the same response.
 */

import type { APIRoute } from 'astro';

import {
  LAYOUT_COLUMNS,
  errorResponse,
  isLayoutId,
  json,
  layoutIssuesFor,
  notFound,
  parseLayoutRow,
  readJson,
  requireSession,
  toLayoutRecord,
  unauthorized,
} from '../../../lib/layout/layout-api';
import { UpdateLayoutSchema } from '../../../lib/schemas/layout';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isLayoutId(params.id)) return notFound();

  const { data, error } = await session.supabase
    .from('layouts')
    .select(LAYOUT_COLUMNS)
    .eq('id', params.id)
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return notFound();

  const record = toLayoutRecord(parseLayoutRow(data));

  return json({ layout: record, issues: layoutIssuesFor(record) });
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isLayoutId(params.id)) return notFound();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = UpdateLayoutSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'Layout is malformed.', details: parsed.error.issues }, 400);
  }

  const { name, layout } = parsed.data;

  // No `user_id` in the update payload. The column keeps whatever the insert
  // set, and the update policy refuses to hand a row to anyone else anyway.
  const { data, error } = await session.supabase
    .from('layouts')
    .update({
      name,
      width: layout.width,
      height: layout.height,
      grid: { obstacles: layout.obstacles, stations: layout.stations, start: layout.start },
    })
    .eq('id', params.id)
    .select(LAYOUT_COLUMNS)
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  // Zero rows means the row is invisible to this user, or gone. Same answer.
  if (!data) return notFound();

  const record = toLayoutRecord(parseLayoutRow(data));

  // Issues never block the save: a draft with problems is the point. They come
  // back so the editor can show what is still wrong after a reload.
  return json({ layout: record, issues: layoutIssuesFor(record) });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isLayoutId(params.id)) return notFound();

  const { data, error } = await session.supabase
    .from('layouts')
    .delete()
    .eq('id', params.id)
    .select('id')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return notFound();

  return json({ id: data.id });
};
