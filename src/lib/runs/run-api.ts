/**
 * Shared plumbing for the `/api/runs` endpoints: row mapping, mission reuse, and
 * the one function that actually simulates and persists a run.
 *
 * The ownership rule is the same as `layout-api.ts` and is stated once here:
 * `user_id` comes from the verified session on every path, never from a request
 * body. Row-level security is the backstop, not the mechanism, so a run
 * belonging to another user arrives as no row and leaves as 404.
 *
 * Server-side only — it holds the Supabase queries. Everything the browser needs
 * lives in `src/lib/schemas/mission.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  LAYOUT_COLUMNS,
  errorResponse,
  parseLayoutRow,
  toLayoutRecord,
} from '../layout/layout-api';
import type { Session } from '../layout/layout-api';
import { MissionSchema, PostmortemRecordSchema } from '../schemas/mission';
import type {
  MissionInput,
  MissionRecord,
  MissionSource,
  PostmortemRecord,
  RunDetail,
  RunRecord,
} from '../schemas/mission';
import type { LayoutRecord } from '../schemas/layout';
import { simulate, stripFrames } from '../sim';
import type { Layout, Mission, RunResult } from '../sim';

/** Columns every run handler selects. Note the absence of `frames`. */
export const RUN_COLUMNS =
  'id, mission_id, seed, status, ticks, distance, battery_end, failure, log, created_at';

/**
 * The detail columns: the above plus the cached postmortem.
 *
 * Split from `RUN_COLUMNS` on purpose. The run *history* list selects the narrow
 * set, and a history table of ticks and timestamps has no use for a paragraph of
 * diagnosis per row. Only the single-run reads pay for it.
 */
export const RUN_DETAIL_COLUMNS = `${RUN_COLUMNS}, postmortem`;

export const MISSION_COLUMNS = 'id, layout_id, name, source, plan, created_at';

/** Seed used for every v1 run. Unused by `simulate()`, persisted regardless. */
export const DEFAULT_SEED = 0;

const UuidSchema = z.uuid();

/**
 * Ids are uuids. A malformed one is reported as "not found" rather than "bad
 * request": it cannot name a real row, and Postgres would otherwise raise
 * `invalid input syntax for type uuid` on the query.
 */
export function isRunId(id: string | undefined): id is string {
  return UuidSchema.safeParse(id).success;
}

/** The only 404 helper for runs. Says nothing about whether the id is real. */
export function runNotFound(): Response {
  return errorResponse(404, 'Run not found.');
}

export function missionNotFound(): Response {
  return errorResponse(404, 'Mission not found.');
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * Rows as PostgREST hands them over. `plan`, `failure`, and `log` are `unknown`
 * because they are jsonb: nothing about their contents is guaranteed by the
 * database, so they get parsed rather than trusted.
 *
 * `distance` and `battery_end` are `numeric` columns, which PostgREST may send
 * as a string. Coerced here so the arithmetic downstream is not string
 * concatenation.
 */
const MissionRowSchema = z.object({
  id: z.string(),
  layout_id: z.string(),
  name: z.string(),
  source: z.enum(['ai', 'manual']),
  plan: z.unknown(),
  created_at: z.string(),
});

const RunRowSchema = z.object({
  id: z.string(),
  mission_id: z.string(),
  seed: z.coerce.number().int(),
  status: z.enum(['success', 'failed']),
  ticks: z.coerce.number().int(),
  distance: z.coerce.number(),
  battery_end: z.coerce.number(),
  failure: z.unknown(),
  log: z.unknown(),
  // Absent from a `RUN_COLUMNS` select and present from a `RUN_DETAIL_COLUMNS`
  // one, so one row schema covers both queries rather than two that could drift
  // apart. `.optional()` is doing real work here: a bare `z.unknown()` still
  // requires the *key*, and every narrow select would fail to parse.
  postmortem: z.unknown().optional(),
  created_at: z.string(),
});

export type MissionRow = z.infer<typeof MissionRowSchema>;
export type RunRow = z.infer<typeof RunRowSchema>;

export function parseMissionRow(row: unknown): MissionRow {
  return MissionRowSchema.parse(row);
}

export function parseRunRow(row: unknown): RunRow {
  return RunRowSchema.parse(row);
}

const FailureRowSchema = z
  .object({
    stepIndex: z.number().int().min(0),
    code: z.enum([
      'UNKNOWN_STATION',
      'UNREACHABLE',
      'GRIPPER_FULL',
      'GRIPPER_EMPTY',
      'ITEM_NOT_PRESENT',
      'WRONG_STATION_KIND',
      'BATTERY_DEPLETED',
    ]),
    detail: z.string(),
  })
  .nullable();

const LogRowSchema = z.array(
  z.object({
    tick: z.number().int().min(0),
    stepIndex: z.number().int().min(0),
    op: z.enum(['MOVE_TO', 'PICK', 'PLACE', 'WAIT', 'CHARGE']),
    outcome: z.enum(['ok', 'failed']),
    message: z.string(),
    pos: z.object({ x: z.number().int(), y: z.number().int() }),
    battery: z.number(),
  }),
);

/**
 * A mission row as the browser sees it.
 *
 * A `plan` that fails to parse becomes an empty plan rather than an exception: a
 * row written by an older schema should leave the run page loadable and show an
 * empty step list, not blank the screen.
 */
export function toMissionRecord(row: MissionRow): MissionRecord {
  const plan = MissionSchema.safeParse(row.plan);

  return {
    id: row.id,
    layoutId: row.layout_id,
    name: row.name,
    source: row.source,
    plan: plan.success ? plan.data : { steps: [] },
    createdAt: row.created_at,
  };
}

/**
 * The cached postmortem, or `null`.
 *
 * `null` covers three cases that all answer the same way — a successful run, a
 * failed run nobody has asked about yet, and a row whose stored postmortem no
 * longer parses. The third is why this is a `safeParse`: a jsonb blob written by
 * an older `PROMPT_VERSION` should leave the run page loadable with an "explain
 * this failure" button, not blank the screen.
 */
export function toPostmortemRecord(row: RunRow): PostmortemRecord | null {
  if (row.postmortem === null || row.postmortem === undefined) return null;

  const parsed = PostmortemRecordSchema.safeParse(row.postmortem);

  return parsed.success ? parsed.data : null;
}

export function toRunRecord(row: RunRow): RunRecord {
  const failure = FailureRowSchema.safeParse(row.failure);
  const log = LogRowSchema.safeParse(row.log);

  return {
    id: row.id,
    missionId: row.mission_id,
    seed: row.seed,
    status: row.status,
    ticks: row.ticks,
    distance: row.distance,
    batteryEnd: row.battery_end,
    failure: failure.success ? failure.data : null,
    log: log.success ? log.data : [],
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * `null` means "not yours or not there" — the two are indistinguishable under
 * RLS and both answer 404. No `.eq('user_id', ...)`: the select policy already
 * scopes these, and adding one would imply RLS were optional.
 */
export async function loadMission(
  supabase: SupabaseClient,
  missionId: string,
): Promise<MissionRecord | null> {
  const { data } = await supabase
    .from('missions')
    .select(MISSION_COLUMNS)
    .eq('id', missionId)
    .maybeSingle();

  return data ? toMissionRecord(parseMissionRow(data)) : null;
}

export async function loadLayout(
  supabase: SupabaseClient,
  layoutId: string,
): Promise<LayoutRecord | null> {
  const { data } = await supabase
    .from('layouts')
    .select(LAYOUT_COLUMNS)
    .eq('id', layoutId)
    .maybeSingle();

  return data ? toLayoutRecord(parseLayoutRow(data)) : null;
}

/**
 * One run, with the cached postmortem that rides on the same row.
 *
 * Returned as a pair rather than folded into `RunRecord` because the postmortem
 * is not part of what a run *is* — see the note on `RunDetailSchema`. One query
 * either way, so the caller never pays for the trip it did not need.
 */
export async function loadRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ run: RunRecord; postmortem: PostmortemRecord | null } | null> {
  const { data } = await supabase
    .from('runs')
    .select(RUN_DETAIL_COLUMNS)
    .eq('id', runId)
    .maybeSingle();

  if (!data) return null;

  const row = parseRunRow(data);

  return { run: toRunRecord(row), postmortem: toPostmortemRecord(row) };
}

/** Everything playback needs, in one trip: run, plan, and the grid it ran on. */
export async function loadRunDetail(
  supabase: SupabaseClient,
  runId: string,
): Promise<RunDetail | null> {
  const loaded = await loadRun(supabase, runId);
  if (loaded === null) return null;

  const mission = await loadMission(supabase, loaded.run.missionId);
  if (mission === null) return null;

  const layout = await loadLayout(supabase, mission.layoutId);
  if (layout === null) return null;

  return {
    run: loaded.run,
    mission,
    layout: layout.layout,
    layoutId: layout.id,
    layoutName: layout.name,
    postmortem: loaded.postmortem,
  };
}

// ---------------------------------------------------------------------------
// Mission reuse
// ---------------------------------------------------------------------------

/**
 * A plan reduced to a canonical string, key order and all.
 *
 * Used to tell "the demo mission I already saved" from "a different plan with
 * the same name". `JSON.stringify` on the raw objects would be at the mercy of
 * whatever key order the jsonb round-trip produced, so every step is rebuilt
 * field by field in a fixed order.
 */
export function canonicalPlan(mission: MissionInput): string {
  return JSON.stringify(
    mission.steps.map((step) => {
      switch (step.op) {
        case 'MOVE_TO':
          return ['MOVE_TO', step.stationId];
        case 'PICK':
          return ['PICK', step.stationId, step.item];
        case 'PLACE':
          return ['PLACE', step.stationId, step.item];
        case 'WAIT':
          return ['WAIT', step.ticks];
        case 'CHARGE':
          return ['CHARGE', step.stationId, step.toPercent];
      }
    }),
  );
}

export function sameMission(a: MissionInput, b: MissionInput): boolean {
  return canonicalPlan(a) === canonicalPlan(b);
}

/**
 * Finds the caller's mission with this layout, name, and plan, or inserts one.
 *
 * Reuse keeps the demo buttons from filling the table with identical rows — one
 * mission, many runs, which is also the shape the history list wants. The lookup
 * is narrowed by name so it stays a small scan rather than a full-plan
 * comparison across every mission the user owns.
 */
export async function findOrCreateMission(
  session: Session,
  input: { layoutId: string; name: string; source: MissionSource; plan: MissionInput },
): Promise<{ mission: MissionRecord } | { error: Response }> {
  const { data, error } = await session.supabase
    .from('missions')
    .select(MISSION_COLUMNS)
    .eq('layout_id', input.layoutId)
    .eq('name', input.name)
    .eq('source', input.source)
    .order('created_at', { ascending: true });

  if (error) return { error: errorResponse(500, error.message) };

  for (const row of data ?? []) {
    const existing = toMissionRecord(parseMissionRow(row));

    if (sameMission(existing.plan, input.plan)) return { mission: existing };
  }

  const inserted = await session.supabase
    .from('missions')
    .insert({
      // From the verified session, never the request body.
      user_id: session.user.id,
      layout_id: input.layoutId,
      name: input.name,
      source: input.source,
      plan: input.plan,
    })
    .select(MISSION_COLUMNS)
    .single();

  if (inserted.error) return { error: errorResponse(500, inserted.error.message) };

  return { mission: toMissionRecord(parseMissionRow(inserted.data)) };
}

// ---------------------------------------------------------------------------
// The authoritative run
// ---------------------------------------------------------------------------

/**
 * Simulates a mission server-side and persists the result.
 *
 * This is the only place a run row is written, and the server's answer is
 * authoritative: the browser re-simulates for playback and compares, it does not
 * report. `frames` never reaches the insert — `stripFrames` drops them, and the
 * payload below is spelled out field by field so an accidental spread cannot
 * smuggle them back in (CLAUDE.md rule 6).
 */
export async function createRun(
  session: Session,
  input: { mission: MissionRecord; layout: Layout; seed: number },
): Promise<{ run: RunRecord } | { error: Response }> {
  const plan: Mission = input.mission.plan;
  const result: RunResult = simulate(input.layout, plan, { seed: input.seed });
  const persisted = stripFrames(result);

  const payload = {
    // From the verified session, never the request body.
    user_id: session.user.id,
    mission_id: input.mission.id,
    seed: input.seed,
    status: persisted.status,
    ticks: persisted.ticks,
    distance: persisted.distance,
    battery_end: persisted.batteryEnd,
    failure: persisted.failure ?? null,
    log: persisted.log,
  };

  const { data, error } = await session.supabase
    .from('runs')
    .insert(payload)
    .select(RUN_COLUMNS)
    .single();

  if (error) return { error: errorResponse(500, error.message) };

  return { run: toRunRecord(parseRunRow(data)) };
}

// ---------------------------------------------------------------------------
// The cached postmortem
// ---------------------------------------------------------------------------

/**
 * Writes the postmortem, but only onto a run that does not have one.
 *
 * `.is('postmortem', null)` is the whole point of this function. Two tabs can
 * both open a failed run, both read `postmortem: null`, and both call the model
 * — the cache check in the endpoint cannot prevent that, because there is no
 * lock between the read and the write. This makes the *write* the arbiter: the
 * first update matches the filter and lands, the second matches nothing and
 * comes back empty, and the loser reads the winner's row instead of overwriting
 * it. Without the filter the two would race and the user could watch the
 * diagnosis change under them.
 *
 * `null` therefore means "no row was updated", which is not an error: it is
 * either the race above or a run this user cannot see. The caller re-reads to
 * tell those apart — under RLS they are otherwise indistinguishable, and both
 * have a correct answer that is not a 500.
 */
export async function savePostmortem(
  session: Session,
  runId: string,
  record: PostmortemRecord,
): Promise<{ postmortem: PostmortemRecord } | { error: Response } | null> {
  const { data, error } = await session.supabase
    .from('runs')
    .update({ postmortem: record })
    .eq('id', runId)
    .is('postmortem', null)
    .select(RUN_DETAIL_COLUMNS)
    .maybeSingle();

  if (error !== null) return { error: errorResponse(500, error.message) };
  if (data === null) return null;

  const saved = toPostmortemRecord(parseRunRow(data));

  // The row came back, so the update landed. A postmortem that will not parse on
  // the way out means the record and its schema have diverged — a programmer
  // error, and one worth reporting rather than answering with a silent null.
  if (saved === null) {
    return { error: errorResponse(500, 'The postmortem was saved but could not be read back.') };
  }

  return { postmortem: saved };
}
