/**
 * GET  /api/runs?missionId= — run history for a mission, newest first.
 * GET  /api/runs?layoutId=  — run history for a layout, newest first.
 * POST /api/runs            — simulate a mission server-side and persist it.
 *
 * POST is authoritative. The browser re-runs `simulate()` for playback and
 * compares its own numbers against the row this endpoint wrote; it never
 * reports them. `frames` are not in the insert payload and never will be
 * (CLAUDE.md rule 6) — see `createRun` in `src/lib/runs/run-api.ts`.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';

import {
  errorResponse,
  json,
  readJson,
  requireSession,
  unauthorized,
} from '../../../lib/layout/layout-api';
import {
  DEFAULT_SEED,
  RUN_COLUMNS,
  createRun,
  isRunId,
  loadLayout,
  loadMission,
  missionNotFound,
  parseRunRow,
  toRunRecord,
} from '../../../lib/runs/run-api';
import { CreateRunSchema } from '../../../lib/schemas/mission';

export const prerender = false;

/** The `missions` id-only select below. Narrowed rather than trusted. */
const MissionIdRowSchema = z.object({ id: z.string() });

export const GET: APIRoute = async ({ locals, url }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  const missionId = url.searchParams.get('missionId');
  const layoutId = url.searchParams.get('layoutId');

  // A malformed id cannot name a real row and would make Postgres raise a uuid
  // syntax error, so it is rejected before the query rather than after.
  if (missionId !== null && !isRunId(missionId)) {
    return errorResponse(400, 'missionId must be a uuid.');
  }

  if (layoutId !== null && !isRunId(layoutId)) {
    return errorResponse(400, 'layoutId must be a uuid.');
  }

  if (missionId === null && layoutId === null) {
    return errorResponse(400, 'Pass missionId or layoutId.');
  }

  // Scoping to the caller comes from the select policy, not from a filter here.
  let query = session.supabase
    .from('runs')
    .select(RUN_COLUMNS)
    .order('created_at', { ascending: false });

  if (missionId !== null) {
    query = query.eq('mission_id', missionId);
  }

  if (layoutId !== null) {
    // `runs` has no layout_id, so the mission ids for that layout come first.
    // Two round trips beats an embedded select whose RLS behaviour would be one
    // more thing to reason about.
    const { data, error } = await session.supabase
      .from('missions')
      .select('id')
      .eq('layout_id', layoutId);

    if (error) return errorResponse(500, error.message);

    const missionIds = (data ?? []).map((row) => MissionIdRowSchema.parse(row).id);

    // No missions means no runs. Returning early also avoids an empty `in()`
    // filter, which PostgREST rejects as malformed.
    if (missionIds.length === 0) return json({ runs: [] });

    query = query.in('mission_id', missionIds);
  }

  const { data, error } = await query;

  if (error) return errorResponse(500, error.message);

  return json({ runs: (data ?? []).map((row) => toRunRecord(parseRunRow(row))) });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = CreateRunSchema.safeParse(body);
  if (!parsed.success) return errorResponse(400, 'A run needs a missionId.');

  const mission = await loadMission(session.supabase, parsed.data.missionId);
  // Another user's mission is invisible under RLS, so it arrives as no row and
  // leaves as 404. Nothing here confirms the id exists.
  if (mission === null) return missionNotFound();

  const layout = await loadLayout(session.supabase, mission.layoutId);
  // A mission whose layout is unreadable is as good as absent — same answer.
  if (layout === null) return missionNotFound();

  const created = await createRun(session, {
    mission,
    layout: layout.layout,
    seed: parsed.data.seed ?? DEFAULT_SEED,
  });

  if ('error' in created) return created.error;

  return json({ run: created.run, mission, layoutId: layout.id }, 201);
};
