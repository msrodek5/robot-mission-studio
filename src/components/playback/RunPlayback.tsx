import { useEffect, useMemo, useRef, useState } from 'react';

import { GridView } from '../grid/GridView';
import type { GridOverlay } from '../grid/GridView';
import { RunDetailSchema } from '../../lib/schemas/mission';
import type { RunDetail } from '../../lib/schemas/mission';
import { simulate } from '../../lib/sim';
import type { Frame, Layout, RunResult, Step } from '../../lib/sim';
import { PostmortemCard } from './PostmortemCard';
import { compareRun, traceUpTo } from './run-trace';
import type { Divergence } from './run-trace';
import { stepLabel } from './step-label';

type Props = {
  runId: string;
};

/** Frames advanced per second at 1x. 4x multiplies this. */
const FRAMES_PER_SECOND = 6;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'diverged'; detail: RunDetail; divergences: Divergence[] }
  | { status: 'ready'; detail: RunDetail; result: RunResult };

/**
 * Playback for one persisted run.
 *
 * The run row is authoritative; frames are not stored (CLAUDE.md rule 6). So
 * this fetches the run, then re-runs `simulate()` in the browser against the
 * same layout, plan, and seed to rebuild the frames — the same pure function the
 * server used, which is the whole payoff of keeping `src/lib/sim` dependency
 * free.
 *
 * If the recomputed status or tick count disagrees with the persisted one, that
 * means determinism is broken somewhere, and a plausible-looking animation would
 * be the worst possible outcome. So it refuses to render the player and says so.
 */
export function RunPlayback({ runId }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    // Guards against a response landing after the component is gone, and
    // against an in-flight request for a previous runId being applied.
    let active = true;

    async function fetchRun() {
      try {
        const response = await fetch(`/api/runs/${runId}`);

        if (!response.ok) {
          if (!active) return;
          setLoad({ status: 'error', message: await messageFrom(response) });
          return;
        }

        const detail = RunDetailSchema.parse(await response.json());
        const result = simulate(detail.layout, detail.mission.plan, { seed: detail.run.seed });
        const divergences = compareRun(detail, result);

        if (!active) return;

        setLoad(
          divergences.length > 0
            ? { status: 'diverged', detail, divergences }
            : { status: 'ready', detail, result },
        );
      } catch {
        if (!active) return;
        setLoad({ status: 'error', message: 'Could not load this run.' });
      }
    }

    void fetchRun();

    return () => {
      active = false;
    };
  }, [runId]);

  if (load.status === 'loading') {
    return <p className="text-sm text-slate-400">Loading run…</p>;
  }

  if (load.status === 'error') {
    return <Banner tone="error">{load.message}</Banner>;
  }

  if (load.status === 'diverged') {
    return <DivergenceReport detail={load.detail} divergences={load.divergences} />;
  }

  return <Player detail={load.detail} result={load.result} />;
}

function DivergenceReport({
  detail,
  divergences,
}: {
  detail: RunDetail;
  divergences: Divergence[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="error">
        <strong className="block">Determinism check failed — playback refused.</strong>
        Re-running this mission in the browser produced a different result from the one the server
        persisted. The same layout, plan, and seed must always produce the same run, so something in
        the simulator or the stored data has drifted. Nothing is animated below on purpose: a
        plausible-looking replay of the wrong run is worse than none.
      </Banner>

      <table className="max-w-lg text-sm">
        <thead className="text-left text-slate-400">
          <tr>
            <th className="py-1 pr-4 font-medium">Field</th>
            <th className="py-1 pr-4 font-medium">Persisted</th>
            <th className="py-1 font-medium">Recomputed</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {divergences.map((divergence) => (
            <tr key={divergence.field}>
              <td className="py-1 pr-4">{divergence.field}</td>
              <td className="py-1 pr-4 text-slate-300">{divergence.persisted}</td>
              <td className="py-1 text-red-300">{divergence.recomputed}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-slate-500">
        Run {detail.run.id} · mission “{detail.mission.name}” · seed {detail.run.seed}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

function Player({ detail, result }: { detail: RunDetail; result: RunResult }) {
  const frames = result.frames;
  const lastIndex = Math.max(0, frames.length - 1);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 4>(1);

  /**
   * Fractional frames carried between animation callbacks.
   *
   * `requestAnimationFrame` fires at whatever rate the display runs, so the
   * accumulator is what keeps playback speed the same on a 60Hz and a 120Hz
   * screen. `setInterval` would drift and would keep firing in a background tab.
   */
  const accumulator = useRef(0);

  useEffect(() => {
    if (!playing) return;

    let raf = 0;
    let previous: number | null = null;

    const tick = (now: number) => {
      const elapsed = previous === null ? 0 : (now - previous) / 1000;
      previous = now;

      accumulator.current += elapsed * FRAMES_PER_SECOND * speed;

      const advance = Math.floor(accumulator.current);

      if (advance > 0) {
        accumulator.current -= advance;
        setIndex((current) => Math.min(current + advance, lastIndex));
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [playing, speed, lastIndex]);

  // Pause on the final frame rather than spinning rAF against a clamped index.
  useEffect(() => {
    if (playing && index >= lastIndex) setPlaying(false);
  }, [playing, index, lastIndex]);

  function togglePlay() {
    accumulator.current = 0;

    // Pressing play at the end replays from the top — the alternative is a
    // button that visibly does nothing.
    if (!playing && index >= lastIndex) setIndex(0);

    setPlaying((current) => !current);
  }

  function goTo(next: number) {
    setPlaying(false);
    accumulator.current = 0;
    setIndex(Math.min(Math.max(next, 0), lastIndex));
  }

  const frame: Frame | undefined = frames[index];
  const trace = useMemo(() => traceUpTo(frames, index), [frames, index]);

  const overlay: GridOverlay = {
    robot: frame?.pos ?? null,
    visited: trace.visited,
    carrying: frame?.carrying ?? null,
  };

  const currentStep = frame?.stepIndex ?? 0;
  const failingStep = detail.run.failure?.stepIndex ?? null;

  return (
    <div className="flex flex-col gap-6">
      {detail.run.failure === null ? (
        <Banner tone="ok">
          <strong>Success.</strong> {detail.run.ticks} ticks, {detail.run.distance} cells,{' '}
          {detail.run.batteryEnd}% battery left.
        </Banner>
      ) : (
        <Banner tone="error">
          <span className="font-mono text-xs text-red-400">{detail.run.failure.code}</span>
          <span className="ml-2">{detail.run.failure.detail}</span>
          <span className="mt-1 block text-xs text-red-300/80">
            Failed at step {detail.run.failure.stepIndex + 1}.
          </span>
        </Banner>
      )}

      {/* US-6. Only on a failed run: a successful one has nothing to diagnose,
          and the endpoint answers 409 if asked anyway. */}
      {detail.run.failure !== null && (
        <PostmortemCard
          runId={detail.run.id}
          cached={detail.postmortem}
          steps={detail.mission.plan.steps}
          layout={detail.layout}
        />
      )}

      <div className="flex flex-wrap items-start gap-8">
        <div className="flex flex-col gap-3">
          <GridView layout={detail.layout} overlay={overlay} label="Run playback grid" />

          <Controls
            index={index}
            lastIndex={lastIndex}
            playing={playing}
            speed={speed}
            onToggle={togglePlay}
            onGoTo={goTo}
            onSpeed={setSpeed}
          />

          <Legend />
        </div>

        <div className="flex min-w-72 flex-col gap-4">
          <Metrics
            tick={frame?.tick ?? 0}
            distance={trace.distance}
            battery={frame?.battery ?? 0}
            carrying={frame?.carrying ?? null}
            finalTicks={detail.run.ticks}
            finalDistance={detail.run.distance}
          />

          <StepList
            steps={detail.mission.plan.steps}
            layout={detail.layout}
            currentStep={currentStep}
            failingStep={failingStep}
          />
        </div>
      </div>
    </div>
  );
}

function Controls({
  index,
  lastIndex,
  playing,
  speed,
  onToggle,
  onGoTo,
  onSpeed,
}: {
  index: number;
  lastIndex: number;
  playing: boolean;
  speed: 1 | 4;
  onToggle: () => void;
  onGoTo: (next: number) => void;
  onSpeed: (speed: 1 | 4) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="w-20 rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium"
        >
          {playing ? 'Pause' : 'Play'}
        </button>

        <button
          type="button"
          onClick={() => onGoTo(index - 1)}
          disabled={index === 0}
          aria-label="Step back"
          className="rounded bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          ‹ Step
        </button>

        <button
          type="button"
          onClick={() => onGoTo(index + 1)}
          disabled={index >= lastIndex}
          aria-label="Step forward"
          className="rounded bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Step ›
        </button>

        <button
          type="button"
          onClick={() => onSpeed(speed === 1 ? 4 : 1)}
          aria-label={`Playback speed ${speed}x`}
          className="rounded bg-slate-700 px-3 py-1.5 text-sm"
        >
          {speed}x
        </button>
      </div>

      <label className="flex items-center gap-3 text-xs text-slate-400">
        <input
          type="range"
          min={0}
          max={lastIndex}
          step={1}
          value={index}
          aria-label="Frame"
          onChange={(event) => onGoTo(Number.parseInt(event.target.value, 10))}
          className="w-72 accent-cyan-500"
        />
        <span className="font-mono whitespace-nowrap">
          {index} / {lastIndex}
        </span>
      </label>
    </div>
  );
}

function Metrics({
  tick,
  distance,
  battery,
  carrying,
  finalTicks,
  finalDistance,
}: {
  tick: number;
  distance: number;
  battery: number;
  carrying: string | null;
  finalTicks: number;
  finalDistance: number;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <dt className="text-slate-400">Tick</dt>
      <dd className="font-mono">
        {tick} <span className="text-slate-500">/ {finalTicks}</span>
      </dd>

      <dt className="text-slate-400">Distance</dt>
      <dd className="font-mono">
        {distance} <span className="text-slate-500">/ {finalDistance}</span>
      </dd>

      <dt className="text-slate-400">Battery</dt>
      <dd className="font-mono">{battery}%</dd>

      <dt className="text-slate-400">Carrying</dt>
      <dd className="font-mono">{carrying ?? '—'}</dd>
    </dl>
  );
}

function StepList({
  steps,
  layout,
  currentStep,
  failingStep,
}: {
  steps: Step[];
  layout: Layout;
  currentStep: number;
  failingStep: number | null;
}) {
  if (steps.length === 0) {
    return <p className="text-sm text-slate-400">This mission has no steps.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Plan</h2>

      <ol className="flex flex-col gap-1">
        {steps.map((step, stepIndex) => {
          const isFailing = stepIndex === failingStep;
          const isCurrent = stepIndex === currentStep;

          return (
            <li
              key={stepIndex}
              aria-current={isCurrent ? 'step' : undefined}
              // The failing step is otherwise distinguished by colour alone,
              // which nothing but an eye can read. The E2E suite asserts on this
              // rather than on a Tailwind class.
              data-step-index={stepIndex}
              data-failing={isFailing ? 'true' : undefined}
              className={[
                'flex gap-2 rounded border px-2 py-1 text-sm',
                isFailing
                  ? 'border-red-500/60 bg-red-500/10 text-red-200'
                  : isCurrent
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-100'
                    : 'border-transparent text-slate-300',
              ].join(' ')}
            >
              <span className="w-4 shrink-0 text-right font-mono text-xs text-slate-500">
                {stepIndex + 1}
              </span>
              <span>{stepLabel(step, layout)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-slate-400">
      <LegendItem className="bg-emerald-400">Robot</LegendItem>
      <LegendItem className="bg-cyan-900/60 ring-1 ring-cyan-400/50 ring-inset">Visited</LegendItem>
      <LegendItem className="bg-cyan-500">Start</LegendItem>
      <LegendItem className="bg-amber-400">Station</LegendItem>
      <LegendItem className="bg-slate-500">Obstacle</LegendItem>
    </ul>
  );
}

function LegendItem({ className, children }: { className: string; children: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 ${className}`} aria-hidden="true" />
      {children}
    </li>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  const className =
    tone === 'ok'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
      : 'border-red-500/40 bg-red-500/10 text-red-200';

  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={`rounded border px-3 py-2 text-sm ${className}`}>
      {children}
    </p>
  );
}

async function messageFrom(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);

  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };

    if (typeof error === 'string') return error;
  }

  return `Request failed (${response.status}).`;
}
