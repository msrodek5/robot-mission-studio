/**
 * The postmortem prompt — a failed run in, a plain-language explanation out.
 *
 * ## What the model is given, and what it is not
 *
 * Five things, and nothing else: the grid dimensions, the station list as
 * `id | name | kind`, the plan with its step indices, the failure object, and
 * the tail of the log. No obstacle grid and no frames.
 *
 * The reason is the same one that shapes the planner prompt, arrived at from the
 * other direction. The planner is denied obstacles so it does not try to route;
 * the postmortem is denied them so it does not try to *explain* the route. A
 * model handed a wall map will confidently narrate a path the robot never took —
 * `simulate()` already decided where it went, and the log says so. Frames are
 * withheld for a plainer reason: they are recomputed, never stored (CLAUDE.md
 * rule 6), and a hundred per-tick positions would bury the one line that matters.
 *
 * The log tail is the load-bearing input. `failure.detail` says what went wrong
 * at the failing step; the entries before it say what the robot had already done
 * to get into that state, which is the difference between "the gripper was full"
 * and "the gripper was full because step 1 picked a bolt that was never placed".
 *
 * ## Versioning
 *
 * Bump `PROMPT_VERSION` on any change to the system text or the context format.
 * It is persisted on every postmortem, so a diagnosis can always be traced back
 * to the prompt that produced it. The context builders below are deliberately
 * this module's own rather than shared with `plan-mission.ts`: the two prompts
 * are versioned independently, and a shared formatter would mean an edit made
 * for the planner silently changed what the postmortem was told.
 */

import { z } from 'zod';

import { PostmortemSchema } from '../../schemas/mission';
import type { Failure } from '../../sim';
import type { Layout, LogEntry, Mission, Station, Step } from '../../sim';

export const PROMPT_VERSION = 'postmortem-v1';

export const EMIT_POSTMORTEM_TOOL_NAME = 'emit_postmortem';

/**
 * How many log entries the model sees, counted back from the failure.
 *
 * Twenty covers the whole plan for anything a demo will run — the step cap is
 * forty and most steps produce one entry — while bounding the prompt for a plan
 * that spent its ticks moving. The *end* of the log is the part that matters:
 * the failure is the last entry, and the state that caused it was built by the
 * entries just before.
 */
export const LOG_TAIL = 20;

/**
 * The tool's input schema, derived from `PostmortemSchema` rather than written
 * by hand — CLAUDE.md rule 3. Widen the schema and the model can immediately
 * emit the new field; a hand-copied JSON Schema would drift silently.
 *
 * The caps travel with it: `maxLength` on the diagnosis and `maxItems` on the
 * edits are guidance to the model before they are a gate on its output.
 */
export const POSTMORTEM_JSON_SCHEMA = z.toJSONSchema(PostmortemSchema, { target: 'draft-7' });

/**
 * Instructions, not examples.
 *
 * The audience rule in the first block is the whole product requirement (US-6):
 * the reader is an ops lead who will not read a trace, so `GRIPPER_FULL` is not
 * an answer. The rules after it are the ones the gate in `explain-failure.ts`
 * enforces — stated up front so the repair loop is a backstop, not the mechanism.
 */
export const SYSTEM_PROMPT = [
  'A warehouse robot ran a mission on a grid and the mission failed. You explain',
  'why, to the operator who wrote the mission. They will not read a trace and',
  'they are not a roboticist.',
  '',
  'Call the emit_postmortem tool exactly once, and reply with nothing else.',
  '',
  'The diagnosis:',
  '- Two or three sentences of plain English. What the robot was doing, what',
  '  stopped it, and why that state had come about.',
  '- Name stations by their name, never by their id, and never by coordinates.',
  '- Do not quote the failure code. "The gripper was already full" is an',
  '  explanation; "GRIPPER_FULL" is the thing being explained.',
  '- Explain the cause, not the symptom. If the robot ran out of battery, the',
  '  useful sentence is where the charge went, not that the battery hit zero.',
  '',
  'The suggested edits:',
  '- Each one names a stepIndex from the plan below and one concrete change to',
  '  that step: what to insert before it, what to change in it, or that it',
  '  should be removed.',
  '- Step indices are 0-based and must be indices that exist in the plan. Never',
  '  refer to a step that is not listed.',
  '- Use only station ids and item names that appear in the plan or the station',
  '  list. Never invent one.',
  '- Do not suggest a route, a path, or grid coordinates. The simulator finds',
  '  the route; the plan only names stations.',
  '- If no change to the plan would fix this failure — the destination is walled',
  '  off, say — return an empty list and say so in the diagnosis. An invented',
  '  suggestion is worse than none.',
].join('\n');

export const TOOL_DESCRIPTION = [
  'Emit the postmortem for a failed run: one plain-language diagnosis, plus zero',
  'or more concrete edits, each anchored to a 0-based step index in the plan that',
  'failed.',
].join(' ');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Dimensions and the station list, as `id | name | kind`.
 *
 * Both halves earn their place: the dimensions make "ran out three cells short"
 * a sentence with a sense of scale, and the ids are how the plan below refers to
 * stations, so without the list the model cannot turn `shelf-1` into "Shelf A"
 * for the reader. Station *cells* and the obstacle list are withheld — see the
 * module note.
 */
export function buildLayoutContext(layout: Layout): string {
  const stations = layout.stations.map(formatStation);

  return [
    `Grid: ${layout.width} wide by ${layout.height} tall.`,
    '',
    stations.length === 0
      ? 'Stations: none. Every step in the plan below names a station that is not in this layout.'
      : ['Stations (id | name | kind):', ...stations].join('\n'),
  ].join('\n');
}

function formatStation(station: Station): string {
  return `${station.id} | ${station.name} | ${station.kind}`;
}

/**
 * The plan, one line per step, each prefixed with the index the model must use.
 *
 * The index is printed rather than implied because it is the anchor for every
 * suggested edit, and a model counting list positions gets it wrong. 0-based,
 * matching `failure.stepIndex` — the UI adds one when it renders, this does not.
 */
export function buildPlanContext(mission: Mission): string {
  if (mission.steps.length === 0) {
    return 'Plan: empty. The mission had no steps.';
  }

  return [
    `Plan (${mission.steps.length} steps, 0-based index | step):`,
    ...mission.steps.map((step, index) => `${index} | ${formatStep(step)}`),
  ].join('\n');
}

/**
 * A step as the plan holds it — station *ids*, not names.
 *
 * Deliberately not the sim core's `describeStep`: that is a log format and this
 * is prompt context, and the two should be free to change apart. Ids rather than
 * names because these lines have to line up with the log entries and with the
 * `stationId` the model will name in a suggested edit.
 */
function formatStep(step: Step): string {
  switch (step.op) {
    case 'MOVE_TO':
      return `MOVE_TO ${step.stationId}`;
    case 'PICK':
      return `PICK "${step.item}" at ${step.stationId}`;
    case 'PLACE':
      return `PLACE "${step.item}" at ${step.stationId}`;
    case 'WAIT':
      return `WAIT ${step.ticks} tick(s)`;
    case 'CHARGE':
      return `CHARGE at ${step.stationId} to ${step.toPercent}%`;
  }
}

/** The failure object, spelled out: which step, which code, and the detail. */
export function buildFailureContext(failure: Failure): string {
  return [
    'Failure:',
    `- step index: ${failure.stepIndex}`,
    `- code: ${failure.code}`,
    `- detail: ${failure.detail}`,
  ].join('\n');
}

/**
 * The last `LOG_TAIL` entries, oldest first.
 *
 * Oldest first so the trace reads forwards into the failure. Each line carries
 * the battery reading because a depletion is only explicable with the numbers
 * that led to it, and the position because "no path from here" needs a here.
 */
export function buildLogContext(log: LogEntry[]): string {
  if (log.length === 0) {
    return 'Log: empty. The run failed before any step completed.';
  }

  const tail = log.slice(-LOG_TAIL);
  const omitted = log.length - tail.length;

  const header =
    omitted === 0
      ? `Log (${tail.length} entries, oldest first):`
      : `Log (last ${tail.length} of ${log.length} entries, oldest first; ${omitted} earlier omitted):`;

  return [header, ...tail.map(formatLogEntry)].join('\n');
}

function formatLogEntry(entry: LogEntry): string {
  return [
    `tick ${entry.tick}`,
    `step ${entry.stepIndex}`,
    entry.op,
    entry.outcome,
    `at (${entry.pos.x},${entry.pos.y})`,
    `battery ${entry.battery}%`,
    `— ${entry.message}`,
  ].join(' | ');
}

/**
 * The single user turn: layout, plan, failure, log.
 *
 * In that order on purpose. The layout and plan are the stable half — identical
 * for every run of the same mission — and the failure and log are what differ,
 * which is the order a cache-friendly prompt wants even though nothing here
 * caches yet.
 */
export function buildUserPrompt(
  layout: Layout,
  mission: Mission,
  failure: Failure,
  log: LogEntry[],
): string {
  return [
    buildLayoutContext(layout),
    '',
    buildPlanContext(mission),
    '',
    buildFailureContext(failure),
    '',
    buildLogContext(log),
  ].join('\n');
}

/**
 * The follow-up turn when a postmortem comes back wrong.
 *
 * The rejected postmortem is echoed back as the assistant turn by the caller;
 * this is only the correction. Same reasoning as the planner's repair prompt: it
 * asks for the whole postmortem again rather than a patch, because a diff
 * against something already wrong is the harder task and the result still has to
 * parse from scratch.
 */
export function buildRepairPrompt(problems: string[]): string {
  return [
    'That postmortem was rejected:',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Call emit_postmortem again with a corrected postmortem. Return the whole',
    'thing, not just the part that changed, and anchor every suggested edit to a',
    'step index that exists in the plan above.',
  ].join('\n');
}
