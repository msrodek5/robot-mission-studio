/**
 * Robot Mission Studio — simulation core.
 *
 * Pure TypeScript, zero dependencies. The same `simulate()` runs in the browser
 * for instant preview and on the server for persisted runs, so there is exactly
 * one implementation and no drift between the two.
 *
 * Nothing in this module may import from outside it, read a clock, call
 * `Math.random`, hit the network, or log. Randomness, when it arrives, comes
 * only from `SimOptions.seed`.
 */

export { findPath } from './pathfinding';
export { cellKey, findStation, inBounds, manhattan, obstacleSet, sameCell } from './grid';
export { COSTS, simulate, stripFrames } from './simulate';
export {
  allowedKindsFor,
  describeStep,
  hasBlockingIssues,
  isKindAllowed,
  isValidChargeTarget,
  validateMission,
} from './validate';
export type { HandlingOp } from './validate';
export type {
  Cell,
  Failure,
  FailureCode,
  Frame,
  Issue,
  IssueCode,
  Layout,
  LogEntry,
  Mission,
  RunResult,
  SimOptions,
  Station,
  StationKind,
  Step,
  StepOp,
} from './types';
