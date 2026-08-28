/**
 * POST /api/missions/generate — brief + layoutId → a persisted `Mission`.
 *
 * The order of the guards below is the point. Cheap and local first (session,
 * body shape, brief length), then the rate limit, then the layout load, and
 * only then the model call. Every check that can fail without spending a token
 * happens before the one that spends them.
 */

import type { APIRoute } from 'astro';

import {
  errorResponse,
  json,
  readJson,
  requireSession,
  unauthorized,
} from '../../../lib/layout/layout-api';
import { anthropicMessageCreator, missingKeyFailure } from '../../../lib/ai/client';
import { planMission } from '../../../lib/ai/plan-mission';
import {
  aiGenerationsInLastHour,
  insertAiMission,
  missionNameFromBrief,
  rateLimitExceeded,
} from '../../../lib/missions/mission-api';
import { loadLayout } from '../../../lib/runs/run-api';
import {
  AI_GENERATIONS_PER_HOUR,
  BRIEF_MAX_CHARS,
  GenerateMissionSchema,
} from '../../../lib/schemas/mission';
import type { PlannerErrorCode } from '../../../lib/schemas/mission';
import { validateMission } from '../../../lib/sim';

export const prerender = false;

/**
 * The status each planner failure answers with.
 *
 * `INVALID_OUTPUT` is a 422 rather than a 500: the request was well formed and
 * the server worked correctly — the model could not satisfy it, and the useful
 * next step is the user's, not ours.
 */
const STATUS_FOR: Record<PlannerErrorCode, number> = {
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INVALID_OUTPUT: 422,
};

function plannerError(code: PlannerErrorCode, message: string): Response {
  return json({ error: message, code }, STATUS_FOR[code]);
}

export const POST: APIRoute = async ({ locals, request }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();

  const body = await readJson(request);
  if (body === undefined) return errorResponse(400, 'Body must be JSON.');

  const parsed = GenerateMissionSchema.safeParse(body);

  if (!parsed.success) {
    // The brief cap is also enforced in the textarea, so reaching this means
    // either a direct API call or a bypassed control. Either way, say which.
    return errorResponse(
      400,
      `A brief is required and must be at most ${BRIEF_MAX_CHARS} characters.`,
    );
  }

  const { layoutId, brief } = parsed.data;

  const used = await aiGenerationsInLastHour(session);

  if (used === null) return errorResponse(500, 'Could not check the generation limit.');

  if (rateLimitExceeded(used)) {
    return plannerError(
      'RATE_LIMITED',
      `You have used all ${AI_GENERATIONS_PER_HOUR} generations for this hour. Existing plans can still be edited and run.`,
    );
  }

  const layout = await loadLayout(session.supabase, layoutId);
  // Another user's layout is invisible under RLS, so it arrives as no row and
  // leaves as 404. Nothing here confirms the id exists.
  if (layout === null) return errorResponse(404, 'Layout not found.');

  const create = anthropicMessageCreator();

  if (create === null) {
    const failure = missingKeyFailure();

    return plannerError(failure.code, failure.message);
  }

  const result = await planMission({ layout: layout.layout, brief, create });

  if (!result.ok) return plannerError(result.code, result.message);

  const inserted = await insertAiMission(session, {
    layoutId: layout.id,
    name: missionNameFromBrief(brief),
    brief,
    plan: result.mission,
    model: result.model,
    promptVersion: result.promptVersion,
  });

  if ('error' in inserted) return inserted.error;

  // Re-validated against the layout rather than reusing the planner's own list:
  // the row is what the editor will load, and the issues shown next to it should
  // be derived from the same place the editor derives them.
  const issues = validateMission(layout.layout, inserted.mission.plan);

  return json(
    {
      mission: inserted.mission,
      issues,
      layoutId: layout.id,
      attempts: result.attempts,
      model: result.model,
      promptVersion: result.promptVersion,
      usage: result.usage,
      generationsRemaining: Math.max(0, AI_GENERATIONS_PER_HOUR - (used + 1)),
    },
    201,
  );
};
