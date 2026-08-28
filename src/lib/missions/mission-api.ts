/**
 * Shared plumbing for the `/api/missions` endpoints.
 *
 * Same shape and the same ownership rule as `layout-api.ts` and `run-api.ts`:
 * `user_id` comes from the verified session on every path, never from a request
 * body. Row-level security is the backstop, not the mechanism — a mission
 * belonging to another user arrives as no row and leaves as a 404.
 *
 * Server-side only; it holds Supabase queries. Everything the browser needs is
 * in `src/lib/schemas/mission.ts`.
 */

import { z } from 'zod';

import { errorResponse } from '../layout/layout-api';
import type { Session } from '../layout/layout-api';
import { MISSION_COLUMNS, parseMissionRow, toMissionRecord } from '../runs/run-api';
import { AI_GENERATIONS_PER_HOUR, type MissionInput, type MissionRecord } from '../schemas/mission';

/** Provenance columns on top of what playback already selects. */
export const MISSION_DETAIL_COLUMNS = `${MISSION_COLUMNS}, brief, model, prompt_version`;

const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * How a generated mission is named.
 *
 * The brief is the only thing available and the user wrote it, so its first
 * line is a better label than "Mission 4". Truncated because a 2000-character
 * brief would otherwise become a 2000-character list item.
 */
export function missionNameFromBrief(brief: string): string {
  const firstLine = brief.trim().split('\n')[0].trim();

  if (firstLine.length === 0) return 'Generated mission';

  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}…`;
}

/**
 * Per-user rate limit, counted rather than tracked.
 *
 * Deliberately no `ai_generations` table: the `missions` rows *are* the ledger,
 * one row per successful generation, and a second table would be one more thing
 * to write an RLS policy for and keep in step. `head: true` asks PostgREST for
 * the count without the rows.
 */
export async function aiGenerationsInLastHour(session: Session): Promise<number | null> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  // No user filter: the select policy already scopes this to the caller.
  const { count, error } = await session.supabase
    .from('missions')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'ai')
    .gte('created_at', since);

  if (error !== null) return null;

  return count ?? 0;
}

export function rateLimitExceeded(used: number): boolean {
  return used >= AI_GENERATIONS_PER_HOUR;
}

/**
 * Persists a generated plan.
 *
 * `model` and `prompt_version` are written on the same row as the plan they
 * produced — without them a plan that looks wrong six weeks from now cannot be
 * traced to the prompt that wrote it.
 */
export async function insertAiMission(
  session: Session,
  input: {
    layoutId: string;
    name: string;
    brief: string;
    plan: MissionInput;
    model: string;
    promptVersion: string;
  },
): Promise<{ mission: MissionRecord } | { error: Response }> {
  const { data, error } = await session.supabase
    .from('missions')
    .insert({
      // From the verified session, never the request body.
      user_id: session.user.id,
      layout_id: input.layoutId,
      name: input.name,
      brief: input.brief,
      plan: input.plan,
      source: 'ai',
      model: input.model,
      prompt_version: input.promptVersion,
    })
    .select(MISSION_COLUMNS)
    .single();

  if (error !== null) return { error: errorResponse(500, error.message) };

  return { mission: toMissionRecord(parseMissionRow(data)) };
}

/**
 * Saves an edited plan.
 *
 * `source`, `model`, and `prompt_version` are left alone on purpose: a plan the
 * model wrote and the user then edited is still, in provenance terms, an AI
 * plan that came from that prompt version. Rewriting them would erase the only
 * record of where it started.
 */
export async function updateMissionPlan(
  session: Session,
  missionId: string,
  input: { name: string; plan: MissionInput },
): Promise<{ mission: MissionRecord } | { error: Response } | null> {
  const { data, error } = await session.supabase
    .from('missions')
    .update({ name: input.name, plan: input.plan })
    .eq('id', missionId)
    .select(MISSION_COLUMNS)
    .maybeSingle();

  if (error !== null) return { error: errorResponse(500, error.message) };
  // Zero rows means invisible to this user, or gone. Same answer either way.
  if (data === null) return null;

  return { mission: toMissionRecord(parseMissionRow(data)) };
}

/** The `brief` half of a mission row, for the editor's header. */
const BriefRowSchema = z.object({ brief: z.string().nullable() });

export async function loadMissionBrief(
  session: Session,
  missionId: string,
): Promise<string | null> {
  const { data } = await session.supabase
    .from('missions')
    .select('brief')
    .eq('id', missionId)
    .maybeSingle();

  if (data === null || data === undefined) return null;

  return BriefRowSchema.parse(data).brief;
}
