/**
 * The planning prompt — natural language in, a `Mission` out.
 *
 * ## The division of labour
 *
 * The model emits intent: `MOVE_TO { stationId }`, never a cell coordinate. A*
 * owns routing. That is why the context below contains the grid *dimensions*
 * and the station list and nothing else — no obstacles, no station cells, no
 * start position. The model cannot plan a path around an obstacle it cannot
 * see, and it does not need to: `simulate()` will route between the stations it
 * names. Putting the obstacle grid in here would invite the model to try, and
 * every one of those attempts would be worse than A*.
 *
 * Bump `PROMPT_VERSION` on any change to the system text or the context format.
 * It is persisted on every generated mission, so a plan can always be traced
 * back to the prompt that produced it.
 */

import { z } from 'zod';

import { MissionSchema } from '../../schemas/mission';
import type { Layout, Station } from '../../sim';

export const PROMPT_VERSION = 'plan-v1';

export const EMIT_MISSION_TOOL_NAME = 'emit_mission';

/**
 * The tool's input schema, derived from `MissionSchema` rather than written by
 * hand.
 *
 * CLAUDE.md rule 3 makes the Zod schema the source of truth, and a hand-copied
 * JSON Schema is exactly the kind of duplicate that drifts: add a `Step`
 * variant, forget to mirror it here, and the model can no longer emit it while
 * every type still compiles. `draft-7` is the dialect the Messages API expects.
 */
export const MISSION_JSON_SCHEMA = z.toJSONSchema(MissionSchema, { target: 'draft-7' });

/**
 * Instructions, not examples.
 *
 * The four rules below are the ones `validateMission()` enforces, stated in
 * advance so the repair loop is a backstop rather than the main mechanism. They
 * are phrased as constraints on output because that is what they are — the
 * model is filling in a schema, not holding a conversation.
 */
export const SYSTEM_PROMPT = [
  'You plan missions for a warehouse robot on a grid.',
  '',
  'You are given the grid size and a list of stations. Turn the operator’s brief',
  'into a sequence of steps by calling the emit_mission tool. Call it exactly',
  'once, and reply with nothing else.',
  '',
  'Rules:',
  '- Use only station ids from the provided list. Never invent a station id, and',
  '  never guess one from a name — copy the id exactly as given.',
  '- The robot carries at most one item. PICK before any PLACE, and PLACE what it',
  '  is carrying before the next PICK.',
  '- PICK only at a station of kind "shelf". PLACE only at kind "shelf" or "dock".',
  '- CHARGE only at a station of kind "charger".',
  '- Do not plan a route. MOVE_TO names a station; the simulator finds the path.',
  '  Never emit grid coordinates — there is no step that accepts them.',
  '- End with the gripper empty unless the brief explicitly asks otherwise.',
  '- Keep the plan as short as the brief allows.',
].join('\n');

export const TOOL_DESCRIPTION = [
  'Emit the finished mission plan as an ordered list of steps.',
  'MOVE_TO drives the robot to a station — the simulator routes it, so you only',
  'name the destination. PICK and PLACE move one item at a time. CHARGE tops the',
  'battery up to a percentage at a charger. WAIT idles for a number of ticks.',
].join(' ');

/**
 * Everything the model is told about the layout: dimensions, then one line per
 * station as `id | name | kind`.
 *
 * Station *cells* are omitted deliberately. They would be the first thing a
 * model reached for if it decided to route by hand, and they buy nothing —
 * "which shelf is nearest the dock" is A*'s question, not the planner's.
 */
export function buildLayoutContext(layout: Layout): string {
  const stations = layout.stations.map(formatStation);

  return [
    `Grid: ${layout.width} wide by ${layout.height} tall.`,
    '',
    stations.length === 0
      ? 'Stations: none. This layout has no stations, so no mission is possible.'
      : ['Stations (id | name | kind):', ...stations].join('\n'),
  ].join('\n');
}

function formatStation(station: Station): string {
  return `${station.id} | ${station.name} | ${station.kind}`;
}

/** The first user turn: the layout context, then the operator's own words. */
export function buildUserPrompt(layout: Layout, brief: string): string {
  return [buildLayoutContext(layout), '', 'Operator brief:', brief.trim()].join('\n');
}

/**
 * The follow-up turn when a plan comes back wrong.
 *
 * The rejected plan is echoed back as the assistant turn by the caller; this is
 * only the correction. It says what failed and asks for the whole plan again
 * rather than a patch — a diff against a plan the model already got wrong is a
 * harder task than redoing it, and the result still has to parse from scratch.
 */
export function buildRepairPrompt(problems: string[]): string {
  return [
    'That plan was rejected:',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Call emit_mission again with a corrected plan. Return the complete plan, not',
    'just the changed steps, and use only station ids from the list above.',
  ].join('\n');
}
