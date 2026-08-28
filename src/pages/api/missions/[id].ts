/**
 * GET /api/missions/:id — read one mission, with its lint issues.
 * PUT /api/missions/:id — save the plan editor's state.
 *
 * Both return 404 for a mission the caller does not own. Row-level security
 * makes another user's row invisible, so "not mine" and "not there" arrive here
 * as the same empty result — and leave as the same response.
 *
 * A plan with issues saves. That is deliberate: the editor is where a broken
 * plan gets fixed, and refusing to persist a half-corrected one would mean
 * losing the work on every reload. Running it is what the issues block, and
 * that gate lives on the Run button and in `simulate()`, not here.
 */

import type { APIRoute } from 'astro';

import {
  errorResponse,
  json,
  readJson,
  requireSession,
  unauthorized,
} from '../../../lib/layout/layout-api';
import { updateMissionPlan } from '../../../lib/missions/mission-api';
import { isRunId, loadLayout, loadMission, missionNotFound } from '../../../lib/runs/run-api';
import { MAX_PLAN_STEPS, UpdateMissionSchema } from '../../../lib/schemas/mission';
import { validateMission } from '../../../lib/sim';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isRunId(params.id)) return missionNotFound();

  const mission = await loadMission(session.supabase, params.id);
  if (mission === null) return missionNotFound();

  const layout = await loadLayout(session.supabase, mission.layoutId);
  // A mission whose layout is unreadable is as good as absent — same answer.
  if (layout === null) return missionNotFound();

  return json({
    mission,
    layout: layout.layout,
    layoutId: layout.id,
    layoutName: layout.name,
    issues: validateMission(layout.layout, mission.plan),
  });
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isRunId(params.id)) return missionNotFound();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = UpdateMissionSchema.safeParse(body);

  if (!parsed.success) {
    return json(
      {
        error: `Plan is malformed or longer than ${MAX_PLAN_STEPS} steps.`,
        details: parsed.error.issues,
      },
      400,
    );
  }

  // Load first, so the layout is known before the write and the issues in the
  // response are computed against the grid this plan actually belongs to.
  const existing = await loadMission(session.supabase, params.id);
  if (existing === null) return missionNotFound();

  const layout = await loadLayout(session.supabase, existing.layoutId);
  if (layout === null) return missionNotFound();

  const updated = await updateMissionPlan(session, params.id, parsed.data);

  if (updated === null) return missionNotFound();
  if ('error' in updated) return updated.error;

  return json({
    mission: updated.mission,
    issues: validateMission(layout.layout, updated.mission.plan),
  });
};
