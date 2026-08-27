/**
 * The two pure pieces of playback: what the robot has covered so far, and
 * whether the browser's re-simulation agrees with the persisted run.
 *
 * Split out of `RunPlayback.tsx` so both can be unit-tested without a DOM. The
 * determinism comparison especially: it is the check that decides whether to
 * animate at all, and it should not be reachable only by clicking.
 */

import type { RunDetail } from '../../lib/schemas/mission';
import { cellKey } from '../../lib/sim';
import type { Frame, RunResult } from '../../lib/sim';

export type Divergence = { field: string; persisted: string; recomputed: string };

export type Trace = {
  /** `cellKey`s the robot has stood on, up to and including the current frame. */
  visited: Set<string>;
  /** Cells travelled so far. */
  distance: number;
};

/**
 * Tolerance for the two numeric columns.
 *
 * `distance` and `battery_end` are Postgres `numeric` and arrive as text, so a
 * difference below the simulator's own rounding (1e-3) would be round-trip float
 * dust rather than a determinism break. `status` and `ticks` are integers and
 * text, and are compared exactly.
 */
export const NUMERIC_TOLERANCE = 1e-6;

/**
 * Cells stood on, and cells travelled, up to `index`.
 *
 * Distance is recounted from the frames rather than read off one, because
 * `Frame` carries no distance field — and adding one would mean editing the sim
 * core, which is not in this milestone's scope. Counting position changes gives
 * the same number: every move is exactly one cell.
 */
export function traceUpTo(frames: Frame[], index: number): Trace {
  const visited = new Set<string>();
  let distance = 0;

  for (let i = 0; i <= index && i < frames.length; i += 1) {
    const frame = frames[i];
    visited.add(cellKey(frame.pos));

    if (i > 0 && cellKey(frames[i - 1].pos) !== cellKey(frame.pos)) distance += 1;
  }

  return { visited, distance };
}

/**
 * Compares the persisted run against the one just recomputed in the browser.
 *
 * Every field, not just the two that matter most: if `distance` drifted while
 * `ticks` held, something would still be wrong, and hiding it would cost the
 * next debugging session. An empty result means the two agree and playback may
 * render.
 */
export function compareRun(detail: RunDetail, result: RunResult): Divergence[] {
  const { run } = detail;
  const divergences: Divergence[] = [];

  if (result.status !== run.status) {
    divergences.push({ field: 'status', persisted: run.status, recomputed: result.status });
  }

  if (result.ticks !== run.ticks) {
    divergences.push({
      field: 'ticks',
      persisted: String(run.ticks),
      recomputed: String(result.ticks),
    });
  }

  if (Math.abs(result.distance - run.distance) > NUMERIC_TOLERANCE) {
    divergences.push({
      field: 'distance',
      persisted: String(run.distance),
      recomputed: String(result.distance),
    });
  }

  if (Math.abs(result.batteryEnd - run.batteryEnd) > NUMERIC_TOLERANCE) {
    divergences.push({
      field: 'batteryEnd',
      persisted: String(run.batteryEnd),
      recomputed: String(result.batteryEnd),
    });
  }

  const persistedCode = run.failure?.code ?? 'none';
  const recomputedCode = result.failure?.code ?? 'none';

  if (persistedCode !== recomputedCode) {
    divergences.push({
      field: 'failure.code',
      persisted: persistedCode,
      recomputed: recomputedCode,
    });
  }

  const persistedStep = run.failure === null ? 'none' : String(run.failure.stepIndex);
  const recomputedStep =
    result.failure === undefined ? 'none' : String(result.failure.stepIndex);

  if (persistedStep !== recomputedStep) {
    divergences.push({
      field: 'failure.stepIndex',
      persisted: persistedStep,
      recomputed: recomputedStep,
    });
  }

  return divergences;
}
