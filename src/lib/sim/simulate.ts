import { findStation } from './grid';
import { findPath } from './pathfinding';
import { isKindAllowed } from './validate';
import type {
  Cell,
  Failure,
  FailureCode,
  Frame,
  Layout,
  LogEntry,
  Mission,
  RunResult,
  SimOptions,
  Station,
  Step,
} from './types';

/** v1 cost model. Deliberately boring; every number here is a golden test. */
export const COSTS = {
  ticksPerCell: 1,
  batteryPerCell: 0.5,
  /** PICK and PLACE */
  ticksPerHandling: 2,
  batteryPerHandling: 1,
  /** CHARGE: 1 tick per 5% */
  percentPerChargeTick: 5,
  batteryStart: 100,
} as const;

type RunState = {
  pos: Cell;
  battery: number;
  carrying: string | null;
  tick: number;
  distance: number;
  /** stationId -> items currently sitting there */
  inventory: Map<string, string[]>;
  stepIndex: number;
  frames: Frame[];
  log: LogEntry[];
};

type StepOutcome =
  | { ok: true; message: string }
  | { ok: false; code: FailureCode; detail: string };

type TravelOutcome =
  | { ok: true; cells: number }
  | { ok: false; code: 'UNREACHABLE' | 'BATTERY_DEPLETED'; detail: string };

/**
 * Run a mission against a layout.
 *
 * Pure and total: never throws for a bad mission, never reads a clock, never
 * consults `Math.random`. `layout + mission + opts` fully determines the
 * result, which is what lets playback recompute `frames` from scratch.
 */
export function simulate(layout: Layout, mission: Mission, opts: SimOptions): RunResult {
  // Reserved for stochastic events (station busy, wheel slip). Referenced so
  // the parameter is not silently droppable; it must not influence v1 output.
  void opts.seed;

  const state = initState(layout, opts);
  pushFrame(state);

  for (let stepIndex = 0; stepIndex < mission.steps.length; stepIndex += 1) {
    const step = mission.steps[stepIndex];
    state.stepIndex = stepIndex;

    const outcome = runStep(state, layout, step);

    if (!outcome.ok) {
      appendLog(state, step, 'failed', outcome.detail);
      return toResult(state, 'failed', {
        stepIndex,
        code: outcome.code,
        detail: outcome.detail,
      });
    }

    appendLog(state, step, 'ok', outcome.message);
  }

  return toResult(state, 'success');
}

/** `RunResult` as it goes to the database: everything except `frames`. */
export function stripFrames(result: RunResult): Omit<RunResult, 'frames'> {
  const { frames: _frames, ...persisted } = result;
  return persisted;
}

function initState(layout: Layout, opts: SimOptions): RunState {
  const inventory = new Map<string, string[]>();
  for (const station of layout.stations) {
    inventory.set(station.id, [...(station.items ?? [])]);
  }

  return {
    pos: { ...layout.start },
    battery: round(opts.batteryStart ?? COSTS.batteryStart),
    carrying: null,
    tick: 0,
    distance: 0,
    inventory,
    stepIndex: 0,
    frames: [],
    log: [],
  };
}

function runStep(state: RunState, layout: Layout, step: Step): StepOutcome {
  switch (step.op) {
    case 'WAIT':
      return runWait(state, step.ticks);
    case 'MOVE_TO':
      return runMoveTo(state, layout, step.stationId);
    case 'PICK':
      return runPick(state, layout, step.stationId, step.item);
    case 'PLACE':
      return runPlace(state, layout, step.stationId, step.item);
    case 'CHARGE':
      return runCharge(state, layout, step.stationId, step.toPercent);
  }
}

function runWait(state: RunState, ticks: number): StepOutcome {
  // A malformed WAIT is a lint issue, not a runtime failure: validateMission
  // reports it and the executor treats it as a no-op.
  const waited = Number.isInteger(ticks) && ticks > 0 ? ticks : 0;
  advanceTicks(state, waited);
  return { ok: true, message: `Waited ${waited} tick(s).` };
}

function runMoveTo(state: RunState, layout: Layout, stationId: string): StepOutcome {
  const station = findStation(layout, stationId);
  if (station === undefined) return unknownStation(stationId);

  const travel = travelTo(state, layout, station);
  if (!travel.ok) return travel;

  return {
    ok: true,
    message: `Moved ${travel.cells} cell(s) to "${station.name}" at (${station.cell.x},${station.cell.y}).`,
  };
}

function runPick(state: RunState, layout: Layout, stationId: string, item: string): StepOutcome {
  const station = findStation(layout, stationId);
  if (station === undefined) return unknownStation(stationId);
  if (!isKindAllowed('PICK', station.kind)) return wrongKind('PICK', station);

  if (state.carrying !== null) {
    return {
      ok: false,
      code: 'GRIPPER_FULL',
      detail: `Cannot pick "${item}": the gripper is already carrying "${state.carrying}".`,
    };
  }

  // Plan-level problems are reported before the robot spends battery on the
  // trip, so a doomed step never costs ticks.
  const items = state.inventory.get(station.id) ?? [];
  const itemIndex = items.indexOf(item);
  if (itemIndex === -1) {
    return {
      ok: false,
      code: 'ITEM_NOT_PRESENT',
      detail: `"${item}" is not at "${station.name}".`,
    };
  }

  const travel = travelTo(state, layout, station);
  if (!travel.ok) return travel;

  if (!spend(state, COSTS.batteryPerHandling)) {
    return depleted(`picking "${item}" at "${station.name}"`);
  }

  items.splice(itemIndex, 1);
  state.carrying = item;
  advanceTicks(state, COSTS.ticksPerHandling);

  return { ok: true, message: `Picked "${item}" at "${station.name}".` };
}

function runPlace(state: RunState, layout: Layout, stationId: string, item: string): StepOutcome {
  const station = findStation(layout, stationId);
  if (station === undefined) return unknownStation(stationId);
  if (!isKindAllowed('PLACE', station.kind)) return wrongKind('PLACE', station);

  if (state.carrying === null) {
    return {
      ok: false,
      code: 'GRIPPER_EMPTY',
      detail: `Cannot place "${item}": the gripper is empty.`,
    };
  }

  if (state.carrying !== item) {
    return {
      ok: false,
      code: 'ITEM_NOT_PRESENT',
      detail: `Cannot place "${item}": the gripper is carrying "${state.carrying}".`,
    };
  }

  const travel = travelTo(state, layout, station);
  if (!travel.ok) return travel;

  if (!spend(state, COSTS.batteryPerHandling)) {
    return depleted(`placing "${item}" at "${station.name}"`);
  }

  const items = state.inventory.get(station.id) ?? [];
  items.push(item);
  state.inventory.set(station.id, items);
  state.carrying = null;
  advanceTicks(state, COSTS.ticksPerHandling);

  return { ok: true, message: `Placed "${item}" at "${station.name}".` };
}

function runCharge(
  state: RunState,
  layout: Layout,
  stationId: string,
  toPercent: number,
): StepOutcome {
  const station = findStation(layout, stationId);
  if (station === undefined) return unknownStation(stationId);
  if (!isKindAllowed('CHARGE', station.kind)) return wrongKind('CHARGE', station);

  const travel = travelTo(state, layout, station);
  if (!travel.ok) return travel;

  const target = clampPercent(toPercent);
  if (target <= state.battery) {
    return {
      ok: true,
      message: `Battery already at ${round(state.battery)}%; no charge needed to reach ${target}%.`,
    };
  }

  const ticks = Math.ceil((target - state.battery) / COSTS.percentPerChargeTick);
  for (let tick = 0; tick < ticks; tick += 1) {
    state.battery = round(Math.min(target, state.battery + COSTS.percentPerChargeTick));
    state.tick += 1;
    pushFrame(state);
  }
  state.battery = round(target);

  return { ok: true, message: `Charged to ${target}% at "${station.name}" in ${ticks} tick(s).` };
}

/**
 * Walk to a station, paying battery per cell.
 *
 * Every station-targeting op routes through here, so a PICK with no preceding
 * MOVE_TO still walks (and can still fail UNREACHABLE or BATTERY_DEPLETED).
 * When the robot is already there the path is one cell long and costs nothing.
 */
function travelTo(state: RunState, layout: Layout, station: Station): TravelOutcome {
  const path = findPath(layout, state.pos, station.cell);
  if (path === null) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      detail: `No path from (${state.pos.x},${state.pos.y}) to "${station.name}" at (${station.cell.x},${station.cell.y}).`,
    };
  }

  const total = path.length - 1;
  for (let i = 1; i < path.length; i += 1) {
    if (!spend(state, COSTS.batteryPerCell)) {
      return {
        ok: false,
        code: 'BATTERY_DEPLETED',
        detail: `Battery ran out ${total - (i - 1)} cell(s) short of "${station.name}".`,
      };
    }
    state.pos = path[i];
    state.distance += 1;
    advanceTicks(state, COSTS.ticksPerCell);
  }

  return { ok: true, cells: total };
}

/**
 * Battery is spent before the action it pays for. Reaching exactly 0 counts as
 * depleted — a robot at 0% does not finish the cell it is halfway across.
 */
function spend(state: RunState, amount: number): boolean {
  const remaining = round(state.battery - amount);
  if (remaining <= 0) return false;
  state.battery = remaining;
  return true;
}

function advanceTicks(state: RunState, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    state.tick += 1;
    pushFrame(state);
  }
}

function pushFrame(state: RunState): void {
  state.frames.push({
    tick: state.tick,
    stepIndex: state.stepIndex,
    pos: { ...state.pos },
    battery: round(state.battery),
    carrying: state.carrying,
  });
}

function appendLog(
  state: RunState,
  step: Step,
  outcome: LogEntry['outcome'],
  message: string,
): void {
  state.log.push({
    tick: state.tick,
    stepIndex: state.stepIndex,
    op: step.op,
    outcome,
    message,
    pos: { ...state.pos },
    battery: round(state.battery),
  });
}

function toResult(state: RunState, status: RunResult['status'], failure?: Failure): RunResult {
  const result: RunResult = {
    status,
    ticks: state.tick,
    distance: state.distance,
    batteryEnd: round(state.battery),
    frames: state.frames,
    log: state.log,
  };
  return failure === undefined ? result : { ...result, failure };
}

function unknownStation(stationId: string): StepOutcome {
  return {
    ok: false,
    code: 'UNKNOWN_STATION',
    detail: `Station "${stationId}" is not in this layout.`,
  };
}

function wrongKind(op: 'PICK' | 'PLACE' | 'CHARGE', station: Station): StepOutcome {
  return {
    ok: false,
    code: 'WRONG_STATION_KIND',
    detail: `Cannot ${op} at "${station.name}": it is a ${station.kind}.`,
  };
}

function depleted(during: string): StepOutcome {
  return {
    ok: false,
    code: 'BATTERY_DEPLETED',
    detail: `Battery ran out while ${during}.`,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Battery moves in halves and whole percents; this keeps float dust out. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
