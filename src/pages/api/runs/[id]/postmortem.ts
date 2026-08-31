/**
 * POST /api/runs/:id/postmortem — a failed run, explained. Idempotent.
 *
 * "Idempotent" is the load-bearing word and it is why this is a POST that mostly
 * does not write. The first call spends a model call and caches the result on the
 * run row; every call after it returns that same row and spends nothing. A user
 * who reopens a failed run, or reloads it, or opens it in a second tab, must not
 * re-bill the deployment — the implementation plan says so in one line and it is
 * the only cost control this feature has.
 *
 * The guard order is the same discipline as `/api/missions/generate`: cheap and
 * local first (session, id shape), then the load, then the two checks that can
 * answer without a token — is this run even failed, and is it already explained —
 * and only then the model. Nothing that can fail for free fails after the spend.
 *
 * There is deliberately no per-hour rate limit here, unlike the planner. The
 * cache is the limit: one model call per failed run, ever. A user who wanted to
 * spend more would have to keep producing genuinely new failed runs, which is
 * their own work, not a loop.
 */

import type { APIRoute } from 'astro';

import {
  errorResponse,
  json,
  requireSession,
  unauthorized,
} from '../../../../lib/layout/layout-api';
import { anthropicMessageCreator, missingKeyFailure } from '../../../../lib/ai/client';
import { explainFailure } from '../../../../lib/ai/explain-failure';
import {
  isRunId,
  loadRunDetail,
  runNotFound,
  savePostmortem,
} from '../../../../lib/runs/run-api';
import type { PlannerErrorCode, PostmortemRecord } from '../../../../lib/schemas/mission';

export const prerender = false;

/**
 * The status each failure answers with — the same mapping the planner uses,
 * because it is the same taxonomy. `INVALID_OUTPUT` is a 422: the request was
 * well formed and the server worked, the model could not satisfy it, and the run
 * page still has the failure code and detail to fall back on.
 */
const STATUS_FOR: Record<PlannerErrorCode, number> = {
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INVALID_OUTPUT: 422,
};

function postmortemError(code: PlannerErrorCode, message: string): Response {
  return json({ error: message, code }, STATUS_FOR[code]);
}

/** The cached answer. `cached: true` is what the UI uses to skip its spinner. */
function cachedResponse(postmortem: PostmortemRecord): Response {
  return json({ postmortem, cached: true });
}

export const POST: APIRoute = async ({ locals, params }) => {
  const session = requireSession(locals);
  if (!session) return unauthorized();
  if (!isRunId(params.id)) return runNotFound();

  const runId = params.id;

  // One trip for the run, its plan, its layout, and any postmortem already on
  // the row. A run belonging to another user is invisible under RLS, arrives as
  // no row, and leaves as 404 — nothing here confirms the id is real.
  const detail = await loadRunDetail(session.supabase, runId);
  if (detail === null) return runNotFound();

  // Already explained. This is the whole point of the endpoint, so it comes
  // before every other check that could reject a request we can already answer.
  if (detail.postmortem !== null) return cachedResponse(detail.postmortem);

  // `failure` is null exactly when the run succeeded — the database enforces
  // that pairing with a check constraint — so this is one condition, not two.
  if (detail.run.failure === null) {
    return errorResponse(409, 'This run succeeded. There is nothing to explain.');
  }

  const create = anthropicMessageCreator();

  if (create === null) {
    const failure = missingKeyFailure();

    return postmortemError(failure.code, failure.message);
  }

  const result = await explainFailure({
    layout: detail.layout,
    mission: detail.mission.plan,
    failure: detail.run.failure,
    log: detail.run.log,
    create,
  });

  if (!result.ok) return postmortemError(result.code, result.message);

  const record: PostmortemRecord = {
    ...result.postmortem,
    model: result.model,
    promptVersion: result.promptVersion,
    // The one clock reading in this feature, and it is here rather than anywhere
    // near `src/lib/sim` (CLAUDE.md rule 1).
    createdAt: new Date().toISOString(),
  };

  const saved = await savePostmortem(session, runId, record);

  if (saved === null) {
    // No row matched, so another request wrote a postmortem between our read and
    // our write. Theirs is the cached one from here on; ours is discarded rather
    // than made to win a race it entered second.
    const reloaded = await loadRunDetail(session.supabase, runId);

    if (reloaded !== null && reloaded.postmortem !== null) {
      return cachedResponse(reloaded.postmortem);
    }

    // Not a race then — the run stopped being visible to this session. Same
    // answer as it would have got a moment earlier.
    return runNotFound();
  }

  if ('error' in saved) return saved.error;

  return json(
    {
      postmortem: saved.postmortem,
      cached: false,
      attempts: result.attempts,
      model: result.model,
      promptVersion: result.promptVersion,
      usage: result.usage,
    },
    201,
  );
};
