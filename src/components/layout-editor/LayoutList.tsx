import { useState } from 'react';

import type { LayoutRecord } from '../../lib/schemas/layout';

type Props = {
  /** Server-rendered so the list is present on first paint. */
  initial: LayoutRecord[];
};

/**
 * The layout index: create and delete, both through `/api/layouts`.
 *
 * Reads are server-rendered and handed in as `initial`; only mutations go over
 * fetch, which keeps the first paint free of a loading state.
 */
export function LayoutList({ initial }: Props) {
  const [layouts, setLayouts] = useState(initial);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createLayout() {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/layouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!response.ok) {
        setError(await messageFrom(response));
        return;
      }

      const body = (await response.json()) as { layout: LayoutRecord };

      // Straight into the editor — creating a layout and then having to find it
      // in a list is a pointless extra click.
      window.location.href = `/app/layouts/${body.layout.id}`;
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteLayout(record: LayoutRecord) {
    if (!window.confirm(`Delete "${record.name}"? This cannot be undone.`)) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/layouts/${record.id}`, { method: 'DELETE' });

      if (!response.ok) {
        setError(await messageFrom(response));
        return;
      }

      setLayouts((current) => current.filter((candidate) => candidate.id !== record.id));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void createLayout();
        }}
        className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          New layout name
          <input
            value={name}
            aria-label="New layout name"
            onChange={(event) => setName(event.target.value)}
            className="w-64 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          />
        </label>

        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Create
        </button>
      </form>

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {layouts.length === 0 ? (
        <p className="text-sm text-slate-400">
          No layouts yet. Create one above to start drawing.
        </p>
      ) : (
        <ul className="flex max-w-2xl flex-col gap-2">
          {layouts.map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-4 rounded border border-slate-700 px-3 py-2"
            >
              <a href={`/app/layouts/${record.id}`} className="text-cyan-400 underline">
                {record.name}
              </a>

              <span className="text-xs text-slate-500">
                {record.layout.width}x{record.layout.height} ·{' '}
                {record.layout.stations.length} station
                {record.layout.stations.length === 1 ? '' : 's'}
              </span>

              <button
                type="button"
                onClick={() => deleteLayout(record)}
                disabled={busy}
                className="rounded bg-slate-700 px-2 py-1 text-xs disabled:opacity-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
