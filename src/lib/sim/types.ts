/**
 * Types for the simulation core.
 *
 * This module is pure: no imports from outside `src/lib/sim`, no clock, no
 * randomness, no I/O. `layout + mission + seed` fully determines a run, which
 * is what lets playback recompute frames instead of persisting them.
 */

export type Cell = { x: number; y: number };

export type StationKind = 'dock' | 'shelf' | 'charger';

export type Station = {
  id: string;
  name: string;
  cell: Cell;
  kind: StationKind;
  /**
   * Items sitting at this station when the run starts. Omitted means empty.
   * PICK removes from this list, PLACE adds to it.
   */
  items?: string[];
};

export type Layout = {
  /** 5..30 */
  width: number;
  /** 5..30 */
  height: number;
  obstacles: Cell[];
  stations: Station[];
  start: Cell;
};

export type Step =
  | { op: 'MOVE_TO'; stationId: string }
  | { op: 'PICK'; stationId: string; item: string }
  | { op: 'PLACE'; stationId: string; item: string }
  | { op: 'WAIT'; ticks: number }
  | { op: 'CHARGE'; stationId: string; toPercent: number };

export type StepOp = Step['op'];

export type Mission = { steps: Step[] };

export type FailureCode =
  | 'UNKNOWN_STATION'
  | 'UNREACHABLE'
  | 'GRIPPER_FULL'
  | 'GRIPPER_EMPTY'
  | 'ITEM_NOT_PRESENT'
  | 'WRONG_STATION_KIND'
  | 'BATTERY_DEPLETED';

export type Failure = {
  stepIndex: number;
  code: FailureCode;
  detail: string;
};

/** One rendered tick of playback. Recomputed on demand, never persisted. */
export type Frame = {
  tick: number;
  stepIndex: number;
  pos: Cell;
  battery: number;
  carrying: string | null;
};

/** One entry per executed step. Persisted; feeds the postmortem prompt. */
export type LogEntry = {
  tick: number;
  stepIndex: number;
  op: StepOp;
  outcome: 'ok' | 'failed';
  message: string;
  pos: Cell;
  battery: number;
};

export type RunResult = {
  status: 'success' | 'failed';
  failure?: Failure;
  ticks: number;
  distance: number;
  batteryEnd: number;
  /** Playback only — never persisted. */
  frames: Frame[];
  /** Persisted, feeds the postmortem. */
  log: LogEntry[];
};

export type SimOptions = {
  /**
   * Reserved for stochastic events (station busy, wheel slip). Unused in v1,
   * present so adding them later does not change this signature.
   */
  seed: number;
  /** Battery percentage at tick 0. Defaults to 100. */
  batteryStart?: number;
};

/** Static (pre-run) validation findings. See `validate.ts`. */
export type IssueCode =
  | 'EMPTY_MISSION'
  | 'UNKNOWN_STATION'
  | 'WRONG_STATION_KIND'
  | 'GRIPPER_FULL'
  | 'GRIPPER_EMPTY'
  | 'INVALID_WAIT'
  | 'INVALID_CHARGE_TARGET'
  | 'ENDS_CARRYING';

export type Issue = {
  /** `null` for issues about the mission as a whole. */
  stepIndex: number | null;
  code: IssueCode;
  message: string;
  severity: 'error' | 'warning';
};
