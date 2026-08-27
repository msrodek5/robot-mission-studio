/**
 * Zod schemas for missions and runs.
 *
 * Same split as `layout.ts`: the sim core owns the *types*, this module owns the
 * *parsing* of untrusted input into them, and the compile-time assertions at the
 * bottom stop the two drifting apart. The sim core takes no dependencies, ever
 * (CLAUDE.md rule 1), so Zod cannot live inside it.
 *
 * `plan` comes out of a jsonb column and — from M5 — out of an LLM. Both are
 * untrusted input and both parse through `MissionSchema` before anything
 * constructs a `Mission` (CLAUDE.md rule 4).
 *
 * Nothing here touches the database or a secret, so playback in the browser can
 * import it.
 */

import { z } from 'zod';

import type { Mission, RunResult, Step } from '../sim';
import { LayoutSchema } from './layout';

export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('MOVE_TO'), stationId: z.string().min(1) }),
  z.object({ op: z.literal('PICK'), stationId: z.string().min(1), item: z.string().min(1) }),
  z.object({ op: z.literal('PLACE'), stationId: z.string().min(1), item: z.string().min(1) }),
  z.object({ op: z.literal('WAIT'), ticks: z.number().int() }),
  z.object({ op: z.literal('CHARGE'), stationId: z.string().min(1), toPercent: z.number() }),
]);

/**
 * `WAIT.ticks` and `CHARGE.toPercent` are only bounded loosely here on purpose.
 * A nonsensical value is a lint issue for `validateMission()` to report with a
 * step index, not a parse error that rejects the whole plan and tells the user
 * nothing about which step is wrong.
 */
export const MissionSchema = z.object({
  steps: z.array(StepSchema),
});

export const MISSION_SOURCES = ['ai', 'manual'] as const;
export const MissionSourceSchema = z.enum(MISSION_SOURCES);

export const MissionRecordSchema = z.object({
  id: z.string(),
  layoutId: z.string(),
  name: z.string(),
  source: MissionSourceSchema,
  plan: MissionSchema,
  createdAt: z.string(),
});

export const RUN_STATUSES = ['success', 'failed'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);

export const FAILURE_CODES = [
  'UNKNOWN_STATION',
  'UNREACHABLE',
  'GRIPPER_FULL',
  'GRIPPER_EMPTY',
  'ITEM_NOT_PRESENT',
  'WRONG_STATION_KIND',
  'BATTERY_DEPLETED',
] as const;

export const FailureSchema = z.object({
  stepIndex: z.number().int().min(0),
  code: z.enum(FAILURE_CODES),
  detail: z.string(),
});

export const LogEntrySchema = z.object({
  tick: z.number().int().min(0),
  stepIndex: z.number().int().min(0),
  op: z.enum(['MOVE_TO', 'PICK', 'PLACE', 'WAIT', 'CHARGE']),
  outcome: z.enum(['ok', 'failed']),
  message: z.string(),
  pos: z.object({ x: z.number().int(), y: z.number().int() }),
  battery: z.number(),
});

/**
 * A run as the browser sees it.
 *
 * No `frames` key, and there must never be one (CLAUDE.md rule 6). Playback
 * recomputes them from `layout + plan + seed`; a `frames` field here would be
 * the first step towards persisting them.
 */
export const RunRecordSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  seed: z.number().int(),
  status: RunStatusSchema,
  ticks: z.number().int().min(0),
  distance: z.number(),
  batteryEnd: z.number(),
  failure: FailureSchema.nullable(),
  log: z.array(LogEntrySchema),
  createdAt: z.string(),
});

/** What `GET /api/runs/:id` returns: everything playback needs, in one trip. */
export const RunDetailSchema = z.object({
  run: RunRecordSchema,
  mission: MissionRecordSchema,
  layout: LayoutSchema,
  layoutId: z.string(),
  layoutName: z.string(),
});

/** POST /api/runs — the authoritative primitive. */
export const CreateRunSchema = z.object({
  missionId: z.uuid(),
  /** Reserved for stochastic events; unused in v1, so it defaults to 0. */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export const DEMO_KINDS = ['success', 'failing'] as const;

/** POST /api/runs/demo — find-or-create the demo mission, then run it. */
export const CreateDemoRunSchema = z.object({
  layoutId: z.uuid(),
  kind: z.enum(DEMO_KINDS),
});

export type StepInput = z.infer<typeof StepSchema>;
export type MissionInput = z.infer<typeof MissionSchema>;
export type MissionRecord = z.infer<typeof MissionRecordSchema>;
export type MissionSource = z.infer<typeof MissionSourceSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type CreateRunInput = z.infer<typeof CreateRunSchema>;
export type CreateDemoRunInput = z.infer<typeof CreateDemoRunSchema>;
export type DemoKind = (typeof DEMO_KINDS)[number];

/**
 * Drift guard.
 *
 * If someone widens `Step` in the sim core or loosens a field here, one of these
 * stops compiling — which is the point: the schema is the parser for the sim's
 * types, so a silent divergence would mean the API accepts a plan
 * `simulate()` cannot run.
 */
type Expect<T extends true> = T;

export type StepSchemaMatchesSim = Expect<StepInput extends Step ? true : false>;
export type SimStepMatchesSchema = Expect<Step extends StepInput ? true : false>;
export type MissionSchemaMatchesSim = Expect<MissionInput extends Mission ? true : false>;
export type SimMissionMatchesSchema = Expect<Mission extends MissionInput ? true : false>;

/**
 * The persisted half of a `RunResult` — everything except `frames`.
 *
 * The assertion below is rule 6 made mechanical: if a `frames` field is ever
 * added to `RunRecordSchema`, this stops compiling.
 */
export type PersistedRunFields = Omit<RunResult, 'frames'>;
export type RunRecordHasNoFrames = Expect<'frames' extends keyof RunRecord ? false : true>;
