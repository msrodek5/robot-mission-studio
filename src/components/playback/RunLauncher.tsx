import { useState } from 'react';

import {
  DEMO_ITEM,
  demoMissionBlocker,
  failingDemoMissionBlocker,
  withDemoStock,
} from '../../lib/fixtures/demo-missions';
import type { DemoKind } from '../../lib/schemas/mission';
import type { LayoutRecord } from '../../lib/schemas/layout';

type Props = {
  /**
   * The *saved* layout. Runs simulate server-side against what is in the
   * database, so a run started with unsaved edits in the editor above would not
   * match what the user is looking at — the notice below says so.
   */
  record: LayoutRecord;
};

/**
 * The M4 entry point: run a hardcoded mission against this layout.
 *
 * The plans come from `src/lib/fixtures/demo-missions.ts` and are built from
 * whatever stations the layout has, so both buttons explain themselves when the
 * layout cannot support them rather than failing after the click.
 */
export function RunLauncher({ record }: Props) {
  const [busy, setBusy] = useState<DemoKind | 'stock' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { layout } = record;
  const demoBlocker = demoMissionBlocker(layout);
  const failingBlocker = failingDemoMissionBlocker(layout);
  const stockable = withDemoStock(layout);

  async function run(kind: DemoKind) {
    setBusy(kind);
    setError(null);

    try {
      const response = await fetch('/api/runs/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layoutId: record.id, kind }),
      });

      if (!response.ok) {
        setError(await messageFrom(response));
        return;
      }

      const body = (await response.json()) as { run: { id: string } };

      // Straight into playback. The run is already persisted, so a reload of
      // that URL replays the identical run.
      window.location.href = `/app/layouts/${record.id}/runs/${body.run.id}`;
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Puts a demo item on the first shelf and saves the layout.
   *
   * `PICK` fails with `ITEM_NOT_PRESENT` against an empty shelf, and the M3
   * editor has no way to put an item on one — so without this the successful
   * demo would be permanently unavailable on every layout the editor can
   * produce. It writes through the ordinary layout endpoint and reloads, so what
   * happened is visible in the station data afterwards.
   */
  async function stock() {
    if (stockable === null) return;

    setBusy('stock');
    setError(null);

    try {
      const response = await fetch(`/api/layouts/${record.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: record.name, layout: stockable }),
      });

      if (!response.ok) {
        setError(await messageFrom(response));
        return;
      }

      window.location.reload();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 px-4 py-3">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Run a mission</h2>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run('success')}
          disabled={demoBlocker !== null || busy !== null}
          title={demoBlocker?.message}
          className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {busy === 'success' ? 'Running…' : 'Run demo mission'}
        </button>

        <button
          type="button"
          onClick={() => void run('failing')}
          disabled={failingBlocker !== null || busy !== null}
          title={failingBlocker?.message}
          className="rounded bg-slate-700 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {busy === 'failing' ? 'Running…' : 'Run failing demo'}
        </button>

        {demoBlocker?.code === 'NO_STOCKED_SHELF' && stockable !== null && (
          <button
            type="button"
            onClick={() => void stock()}
            disabled={busy !== null}
            className="rounded border border-amber-500/50 px-3 py-1.5 text-sm text-amber-200 disabled:opacity-40"
          >
            {busy === 'stock' ? 'Saving…' : `Stock a shelf with “${DEMO_ITEM}”`}
          </button>
        )}
      </div>

      {demoBlocker !== null && (
        <p className="text-sm text-amber-300/90">
          <span className="font-mono text-xs">{demoBlocker.code}</span>
          <span className="ml-2">{demoBlocker.message}</span>
        </p>
      )}

      {failingBlocker !== null && (
        <p className="text-sm text-amber-300/90">
          <span className="font-mono text-xs">{failingBlocker.code}</span>
          <span className="ml-2">{failingBlocker.message}</span>
        </p>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}

      <p className="text-xs text-slate-500">
        Runs simulate on the server against the <strong>saved</strong> layout. Save the editor first
        if you have just changed something.
      </p>
    </section>
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
