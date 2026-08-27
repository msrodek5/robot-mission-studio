/**
 * POST /api/runs/demo — build a demo mission for a layout, save it, run it.
 *
 * M4 has no planner, so the mission has to come from somewhere. This endpoint is
 * that somewhere: it builds a plan from whatever stations the layout actually
 * has (`src/lib/fixtures/demo-missions.ts`), reuses an identical `missions` row
 * if one exists, and then hands off to the same `createRun` that
 * `POST /api/runs` uses — so there is exactly one code path that writes a run.
 *
 * When the planner lands in M5 this endpoint stays as the deterministic baseline
 * to compare generated plans against.
 */

import type { APIRoute } from 'astro';

import {
  buildDemoMission,
  buildFailingDemoMission,
  demoMissionBlocker,
  failingDemoMissionBlocker,
} from '../../../lib/fixtures/demo-missions';
import {
  errorResponse,
  json,
  notFound,
  readJson,
  requireSession,
  unauthorized,
} from '../../../lib/layout/layout-api';
import { DEFAULT_SEED, createRun, findOrCreateMission, loadLayout } from '../../../lib/runs/run-api';
import { CreateDemoRunSchema } from '../../../lib/schemas/mission';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = CreateDemoRunSchema.safeParse(body);
  if (!parsed.success) return errorResponse(400, 'Pass a layoutId and a kind.');

  const record = await loadLayout(session.supabase, parsed.data.layoutId);
  // Another user's layout is invisible under RLS: no row, 404, no confirmation
  // that the id is real.
  if (record === null) return notFound();

  const { layout } = record;

  const demo =
    parsed.data.kind === 'success' ? buildDemoMission(layout) : buildFailingDemoMission(layout);

  if (demo === null) {
    // The client disables the button for exactly these reasons, but it is
    // reading a layout it may have edited without saving — so the server says
    // why rather than trusting that check.
    const blocker =
      parsed.data.kind === 'success'
        ? demoMissionBlocker(layout)
        : failingDemoMissionBlocker(layout);

    return json(
      { error: blocker?.message ?? 'This layout cannot run the demo mission.', code: blocker?.code },
      422,
    );
  }

  const found = await findOrCreateMission(session, {
    layoutId: record.id,
    name: demo.name,
    source: 'manual',
    plan: demo.mission,
  });

  if ('error' in found) return found.error;

  const created = await createRun(session, {
    mission: found.mission,
    layout,
    seed: DEFAULT_SEED,
  });

  if ('error' in created) return created.error;

  return json({ run: created.run, mission: found.mission, layoutId: record.id }, 201);
};
