import { useState } from 'react';
import { z } from 'zod';

import { BRIEF_MAX_CHARS, type PlannerErrorCode } from '../../lib/schemas/mission';
import type { LayoutRecord } from '../../lib/schemas/layout';
import { isPlannerErrorCode, plannerErrorView } from './planner-errors';

type Props = {
  record: LayoutRecord;
};

type Failure = { code: PlannerErrorCode | null; message: string };

/**
 * US-3 — describe a mission in English, get a plan.
 *
 * The brief cap is enforced here *and* on the server. Not belt and braces: the
 * textarea's `maxLength` is a courtesy to the person typing, and the server
 * check is the actual rule, because a direct POST never sees this component.
 */
export function MissionPlanner({ record }: Props) {
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const trimmed = brief.trim();
  const overLimit = brief.length > BRIEF_MAX_CHARS;
  const stationCount = record.layout.stations.length;

  // Nothing to plan against. Said up front rather than after a wasted call.
  const blocked = stationCount === 0;

  async function generate() {
    setBusy(true);
    setFailure(null);

    try {
      const response = await fetch('/api/missions/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layoutId: record.id, brief: trimmed }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailure(failureFrom(body, response.status));
        return;
      }

      const missionId = missionIdFrom(body);

      if (missionId === null) {
        setFailure({ code: null, message: 'The server returned an unexpected response.' });
        return;
      }

      // Straight into the editor. The plan is already persisted, so a reload of
      // that URL shows the same plan rather than re-billing a generation.
      window.location.href = `/app/missions/${missionId}`;
    } catch {
      setFailure({ code: null, message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 px-4 py-3">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Describe the mission</h2>

      <p className="text-sm text-slate-400">
        Plain English. Name the stations you mean — the planner picks the steps, and the simulator
        works out the route.
      </p>

      <textarea
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        maxLength={BRIEF_MAX_CHARS}
        rows={4}
        disabled={blocked}
        aria-label="Mission brief"
        placeholder="pick a crate from shelf A and drop it at the dock"
        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm disabled:opacity-40"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy || blocked || trimmed.length === 0 || overLimit}
          className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Planning…' : 'Generate plan'}
        </button>

        <span
          className={
            overLimit ? 'font-mono text-xs text-red-300' : 'font-mono text-xs text-slate-500'
          }
        >
          {brief.length} / {BRIEF_MAX_CHARS}
        </span>
      </div>

      {blocked && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          This layout has no stations. Add at least one before planning a mission — the planner can
          only refer to stations that exist.
        </p>
      )}

      {failure !== null && <FailureCard failure={failure} />}

      <p className="text-xs text-slate-500">
        Plans are checked against this layout before they are saved. A plan that still has problems
        opens in the editor with them listed.
      </p>
    </section>
  );
}

function FailureCard({ failure }: { failure: Failure }) {
  const view = failure.code === null ? null : plannerErrorView(failure.code);

  return (
    <div
      role="alert"
      data-error-code={failure.code ?? 'UNKNOWN'}
      className="flex flex-col gap-1 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
    >
      <span className="font-semibold">{view?.title ?? 'Generation failed'}</span>
      <span>{failure.message}</span>
      {view !== null && <span className="text-xs text-red-300/80">{view.hint}</span>}
    </div>
  );
}

/**
 * Response bodies are untrusted input like anything else off the wire, so they
 * are parsed rather than cast. Both schemas are deliberately loose — a response
 * that is missing a field should degrade to a generic message, not throw inside
 * a click handler.
 */
const ErrorBodySchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

const GeneratedBodySchema = z.object({
  mission: z.object({ id: z.string() }),
});

function failureFrom(body: unknown, status: number): Failure {
  const parsed = ErrorBodySchema.safeParse(body);
  const fallback = `Request failed (${status}).`;

  if (!parsed.success) return { code: null, message: fallback };

  return {
    code: isPlannerErrorCode(parsed.data.code) ? parsed.data.code : null,
    message: parsed.data.error ?? fallback,
  };
}

function missionIdFrom(body: unknown): string | null {
  const parsed = GeneratedBodySchema.safeParse(body);

  return parsed.success ? parsed.data.mission.id : null;
}
