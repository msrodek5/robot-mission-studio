import { useMemo, useState } from 'react';
import { z } from 'zod';

import { MAX_PLAN_STEPS, type MissionRecord, type StepInput } from '../../lib/schemas/mission';
import { hasBlockingIssues, validateMission } from '../../lib/sim';
import type { Issue, Layout, StepOp } from '../../lib/sim';
import { STEP_OPS, defaultStep, moveStep } from './step-ops';
import { StepRow } from './StepRow';

type Props = {
  mission: MissionRecord;
  layout: Layout;
  layoutId: string;
  layoutName: string;
};

const SavedSchema = z.object({ mission: z.object({ id: z.string() }) });
const RunSchema = z.object({ run: z.object({ id: z.string() }) });
const ErrorSchema = z.object({ error: z.string().optional() });

/**
 * US-4 — the plan editor and its live linter.
 *
 * `validateMission` is the same pure function the planner gates LLM output with
 * and the same one the server re-runs on save. Running it here on every
 * keystroke is free (no grid walk, no pathfinding) and means the user never
 * discovers a broken plan by running it.
 *
 * Saving is always allowed; running is not. A half-fixed plan must survive a
 * reload, or the editor punishes the user for stopping halfway.
 */
export function MissionEditor({ mission, layout, layoutId, layoutName }: Props) {
  const [name, setName] = useState(mission.name);
  const [steps, setSteps] = useState<StepInput[]>(mission.plan.steps);
  const [addOp, setAddOp] = useState<StepOp>('MOVE_TO');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const issues = useMemo(() => validateMission(layout, { steps }), [layout, steps]);

  // Issues are keyed by step so each row can render its own. `null` covers the
  // ones about the plan as a whole (an empty plan), which have no row to sit on.
  const issuesByStep = useMemo(() => groupByStep(issues), [issues]);
  const planIssues = issuesByStep.get(null) ?? [];

  const blocked = hasBlockingIssues(issues);
  const overCap = steps.length > MAX_PLAN_STEPS;

  function update(next: StepInput[]) {
    setSteps(next);
    setDirty(true);
    setSaved(false);
  }

  function rename(next: string) {
    setName(next);
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setBusy('save');
    setError(null);

    try {
      const response = await fetch(`/api/missions/${mission.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), plan: { steps } }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok || !SavedSchema.safeParse(body).success) {
        setError(messageFrom(body, response.status));
        return;
      }

      setDirty(false);
      setSaved(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * The M4 endpoint, unchanged.
   *
   * It simulates server-side against the *saved* plan, which is why an unsaved
   * edit disables this button rather than silently running the old steps.
   */
  async function run() {
    setBusy('run');
    setError(null);

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ missionId: mission.id }),
      });

      const body: unknown = await response.json().catch(() => null);
      const parsed = RunSchema.safeParse(body);

      if (!response.ok || !parsed.success) {
        setError(messageFrom(body, response.status));
        return;
      }

      window.location.href = `/app/layouts/${layoutId}/runs/${parsed.data.run.id}`;
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  const runBlocker = runBlockerFor({ blocked, dirty, overCap, empty: steps.length === 0 });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="mission-name" className="text-xs tracking-wide text-slate-400 uppercase">
          Mission name
        </label>
        <input
          id="mission-name"
          value={name}
          onChange={(event) => rename(event.target.value)}
          className="w-full max-w-lg rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <p className="text-xs text-slate-500">
          On layout <span className="text-slate-300">{layoutName}</span>
          {mission.source === 'ai' && <span className="ml-2 text-cyan-400">AI-generated</span>}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          Steps ({steps.length}
          {overCap ? ` — over the ${MAX_PLAN_STEPS} limit` : ''})
        </h2>

        {steps.length === 0 ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            This plan has no steps. Add one below.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <StepRow
                // Steps have no stable identity — they are reordered, retyped,
                // and deleted — so the index is the honest key here.
                key={index}
                step={step}
                index={index}
                total={steps.length}
                layout={layout}
                issues={issuesByStep.get(index) ?? []}
                onChange={(next) => update(steps.map((s, i) => (i === index ? next : s)))}
                onMove={(delta) => update(moveStep(steps, index, delta))}
                onDelete={() => update(steps.filter((_, i) => i !== index))}
              />
            ))}
          </ol>
        )}

        {planIssues.map((issue, index) => (
          <p
            key={`${issue.code}-${index}`}
            className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
          >
            <span className="font-mono text-xs">{issue.code}</span>
            <span className="ml-2">{issue.message}</span>
          </p>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={addOp}
          aria-label="Step to add"
          onChange={(event) => setAddOp(event.target.value as StepOp)}
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
        >
          {STEP_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => update([...steps, defaultStep(layout, addOp)])}
          className="rounded border border-slate-600 px-3 py-1.5 text-sm"
        >
          Add step
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null || !dirty}
          className="rounded bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy === 'save' ? 'Saving…' : 'Save plan'}
        </button>

        <button
          type="button"
          onClick={() => void run()}
          disabled={busy !== null || runBlocker !== null}
          title={runBlocker ?? undefined}
          className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {busy === 'run' ? 'Running…' : 'Run mission'}
        </button>

        {saved && !dirty && <span className="text-xs text-emerald-300">Saved.</span>}

        {runBlocker !== null && (
          <span className="text-xs text-amber-300" role="status">
            {runBlocker}
          </span>
        )}
      </div>

      {!blocked && steps.length > 0 && (
        <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          No blocking issues. This plan is ready to run.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Why Run is disabled, in the order the user should deal with them.
 *
 * A single reason at a time: listing three at once reads as "this is hopeless"
 * when the first one is usually the only one standing in the way.
 */
function runBlockerFor(state: {
  blocked: boolean;
  dirty: boolean;
  overCap: boolean;
  empty: boolean;
}): string | null {
  if (state.empty) return 'Add at least one step before running.';
  if (state.overCap) return `A plan may have at most ${MAX_PLAN_STEPS} steps.`;
  if (state.blocked) return 'Fix the issues listed above before running this plan.';
  if (state.dirty) return 'Save your changes first — runs simulate the saved plan.';

  return null;
}

function groupByStep(issues: Issue[]): Map<number | null, Issue[]> {
  const grouped = new Map<number | null, Issue[]>();

  for (const issue of issues) {
    const existing = grouped.get(issue.stepIndex);

    if (existing === undefined) {
      grouped.set(issue.stepIndex, [issue]);
    } else {
      existing.push(issue);
    }
  }

  return grouped;
}

function messageFrom(body: unknown, status: number): string {
  const parsed = ErrorSchema.safeParse(body);

  return parsed.success && parsed.data.error !== undefined
    ? parsed.data.error
    : `Request failed (${status}).`;
}
