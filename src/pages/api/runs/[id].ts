/**
 * GET /api/runs/:id — one run, plus the plan and layout playback needs.
 *
 * Returns 404 for a run the caller does not own. Row-level security makes
 * another user's row invisible, so "not mine" and "not there" arrive here as the
 * same empty result — and they leave as the same response.
 *
 * The layout and plan ride along because playback re-simulates in the browser
 * and cannot do that from the run row alone. One round trip, and the client has
 * no way to substitute a different layout for the one the run was scored on.
 */

import type { APIRoute } from 'astro';

import { errorResponse, json, requireSession, unauthorized } from '../../../lib/layout/layout-api';
import { isRunId, loadRunDetail, runNotFound } from '../../../lib/runs/run-api';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isRunId(params.id)) return runNotFound();

  try {
    const detail = await loadRunDetail(session.supabase, params.id);
    if (detail === null) return runNotFound();

    return json(detail);
  } catch (error) {
    // A row that fails to parse is a schema drift, not a missing run. Saying so
    // beats a 404 that sends the user looking for a run that is right there.
    return errorResponse(500, error instanceof Error ? error.message : 'Run is malformed.');
  }
};
