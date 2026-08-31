import { useState } from 'react';
import { z } from 'zod';

import { PostmortemRecordSchema } from '../../lib/schemas/mission';
import type { PlannerErrorCode, PostmortemRecord } from '../../lib/schemas/mission';
import type { Layout, Step } from '../../lib/sim';
import { postmortemErrorView } from './postmortem-errors';
import { isPlannerErrorCode } from '../mission/planner-errors';
import { stepLabel } from './step-label';

type Props = {
  runId: string;
  /** The postmortem already cached on the run row, if there is one. */
  cached: PostmortemRecord | null;
  steps: Step[];
  layout: Layout;
};

type Failure = { code: PlannerErrorCode | null; message: string };

type State =
  | { status: 'absent' }
  | { status: 'loading' }
  | { status: 'failed'; failure: Failure }
  | { status: 'ready'; postmortem: PostmortemRecord };

/**
 * US-6 — a failed run explained in language the reader can act on.
 *
 * Generation is a button rather than something that fires on page load, and that
 * is a deliberate choice in both directions. It costs a model call, so a user who
 * opened the run to check the tick count should not be billed for prose they did
 * not ask for; and a request that fails is then something they pressed, which
 * makes "try again" an obvious next move rather than a mystery banner.
 *
 * Once generated it is cached on the run row, so the button appears exactly once
 * per failed run and every later visit renders straight from `cached`.
 */
export function PostmortemCard({ runId, cached, steps, layout }: Props) {
  const [state, setState] = useState<State>(
    cached === null ? { status: 'absent' } : { status: 'ready', postmortem: cached },
  );

  async function explain() {
    setState({ status: 'loading' });

    try {
      const response = await fetch(`/api/runs/${runId}/postmortem`, { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setState({ status: 'failed', failure: failureFrom(body, response.status) });
        return;
      }

      const postmortem = postmortemFrom(body);

      if (postmortem === null) {
        setState({
          status: 'failed',
          failure: { code: null, message: 'The server returned an unexpected response.' },
        });
        return;
      }

      setState({ status: 'ready', postmortem });
    } catch {
      setState({ status: 'failed', failure: { code: null, message: 'Could not reach the server.' } });
    }
  }

  if (state.status === 'ready') {
    return <Report postmortem={state.postmortem} steps={steps} layout={layout} />;
  }

  return (
    <section className="flex flex-col items-start gap-2 rounded border border-slate-700 px-4 py-3">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Why did this fail?</h2>

      <p className="text-sm text-slate-400">
        Get a plain-language diagnosis and the specific steps to change. Generated once and stored
        on the run, so reopening this page costs nothing.
      </p>

      <button
        type="button"
        onClick={() => void explain()}
        disabled={state.status === 'loading'}
        className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
      >
        {state.status === 'loading' ? 'Working it out…' : 'Explain this failure'}
      </button>

      {state.status === 'failed' && <FailureCard failure={state.failure} />}
    </section>
  );
}

function Report({
  postmortem,
  steps,
  layout,
}: {
  postmortem: PostmortemRecord;
  steps: Step[];
  layout: Layout;
}) {
  return (
    <section className="flex flex-col gap-3 rounded border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <h2 className="text-sm font-semibold tracking-wide text-amber-200 uppercase">
        Why did this fail?
      </h2>

      <p className="text-sm text-slate-200">{postmortem.diagnosis}</p>

      {postmortem.suggestedEdits.length === 0 ? (
        <p className="text-sm text-slate-400">
          No single step change would fix this — the diagnosis above says what to look at instead.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Suggested edits
          </h3>

          <ol className="flex flex-col gap-2">
            {postmortem.suggestedEdits.map((edit, index) => (
              <li
                key={`${edit.stepIndex}-${index}`}
                className="flex flex-col gap-0.5 rounded border border-slate-700 px-3 py-2 text-sm"
              >
                {/* Step numbers are 1-based on screen and 0-based in the data —
                    the same offset the playback step list uses, so the two
                    panels always name a step the same way. */}
                <span className="text-xs text-slate-400">
                  Step {edit.stepIndex + 1}
                  {describeTarget(steps, layout, edit.stepIndex)}
                </span>
                <span className="text-slate-200">{edit.change}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="font-mono text-xs text-slate-500">
        {postmortem.model} · {postmortem.promptVersion}
      </p>
    </section>
  );
}

/**
 * What the referenced step currently does, so the suggestion has something to be
 * a change *from*.
 *
 * Empty when the index is off the end of the plan. The server rejects those, so
 * reaching this means a row written before that gate existed — and a card that
 * silently drops the label beats one that renders "Step 8 — undefined".
 */
function describeTarget(steps: Step[], layout: Layout, stepIndex: number): string {
  const step = steps[stepIndex];

  return step === undefined ? '' : ` — ${stepLabel(step, layout)}`;
}

function FailureCard({ failure }: { failure: Failure }) {
  const view = failure.code === null ? null : postmortemErrorView(failure.code);

  return (
    <div
      role="alert"
      data-error-code={failure.code ?? 'UNKNOWN'}
      className="flex flex-col gap-1 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
    >
      <span className="font-semibold">{view?.title ?? 'Could not explain this run'}</span>
      <span>{failure.message}</span>
      {view !== null && <span className="text-xs text-red-300/80">{view.hint}</span>}
    </div>
  );
}

/**
 * Response bodies are untrusted input like anything off the wire, so they are
 * parsed rather than cast. The error schema is deliberately loose — a response
 * missing a field should degrade to a generic message, not throw inside a click
 * handler — while the postmortem itself goes through the real schema, because a
 * malformed one would render as a broken card.
 */
const ErrorBodySchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

const PostmortemBodySchema = z.object({ postmortem: PostmortemRecordSchema });

function failureFrom(body: unknown, status: number): Failure {
  const parsed = ErrorBodySchema.safeParse(body);
  const fallback = `Request failed (${status}).`;

  if (!parsed.success) return { code: null, message: fallback };

  return {
    code: isPlannerErrorCode(parsed.data.code) ? parsed.data.code : null,
    message: parsed.data.error ?? fallback,
  };
}

function postmortemFrom(body: unknown): PostmortemRecord | null {
  const parsed = PostmortemBodySchema.safeParse(body);

  return parsed.success ? parsed.data.postmortem : null;
}
