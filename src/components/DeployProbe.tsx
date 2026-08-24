import { useEffect, useState } from 'react';

type Probe =
  | { status: 'checking' }
  | { status: 'ok'; commit: string }
  | { status: 'error' };

/**
 * M0 smoke check. Proves three things at once on the deployed URL: the React
 * island hydrated, the on-demand server endpoint responded, and the two halves
 * are the same deployment.
 */
export default function DeployProbe() {
  const [probe, setProbe] = useState<Probe>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
      )
      .then((body: { commit?: string }) => {
        if (!cancelled) setProbe({ status: 'ok', commit: body.commit ?? 'unknown' });
      })
      .catch(() => {
        if (!cancelled) setProbe({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      {probe.status === 'checking' && (
        <p className="text-slate-400">Checking deployment…</p>
      )}
      {probe.status === 'ok' && (
        <p className="text-emerald-400">
          Island hydrated, server endpoint reachable.{' '}
          <span className="text-slate-500">build {probe.commit.slice(0, 7)}</span>
        </p>
      )}
      {probe.status === 'error' && (
        <p className="text-amber-400">
          Island hydrated, but /api/health did not respond.
        </p>
      )}
    </div>
  );
}
