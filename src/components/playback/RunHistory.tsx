import type { RunRecord } from '../../lib/schemas/mission';

type Props = {
  layoutId: string;
  /** Newest first, server-rendered so the list is in the first paint. */
  runs: RunRecord[];
  /** Mission name per run id, for rows whose mission is worth naming. */
  missionNames: Record<string, string>;
};

/**
 * Run history for one layout.
 *
 * Rendered without a client directive: it is a list of links and needs no
 * JavaScript. Every row points at `/app/layouts/:id/runs/:runId`, where playback
 * recomputes the frames — which is what makes a run replayable after a reload
 * without ever having stored a frame.
 */
export function RunHistory({ layoutId, runs, missionNames }: Props) {
  if (runs.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Runs</h2>
        <p className="text-sm text-slate-400">
          No runs yet. Start one above and it will show up here.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-wide uppercase">
        {runs.length} {runs.length === 1 ? 'run' : 'runs'}
      </h2>

      <ul className="flex flex-col gap-1">
        {runs.map((run) => (
          <li key={run.id}>
            <a
              href={`/app/layouts/${layoutId}/runs/${run.id}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-slate-700 px-3 py-2 text-sm hover:border-cyan-500/60"
            >
              <span
                className={
                  run.status === 'success'
                    ? 'font-medium text-emerald-400'
                    : 'font-medium text-red-400'
                }
              >
                {run.status === 'success' ? 'Success' : 'Failed'}
              </span>

              <span className="text-slate-300">{missionNames[run.id] ?? 'Mission'}</span>

              <span className="font-mono text-xs text-slate-400">
                {run.ticks} ticks · {run.distance} cells · {run.batteryEnd}%
              </span>

              {run.failure !== null && (
                <span className="font-mono text-xs text-red-400">{run.failure.code}</span>
              )}

              <span className="ml-auto text-xs text-slate-500">{formatTime(run.createdAt)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Rendered on the server, so this deliberately does not use the viewer's locale
 * — a server-formatted local time would be the server's idea of local. The ISO
 * timestamp trimmed to minutes is unambiguous and needs no hydration to fix up.
 */
function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16).concat(' UTC');
}
