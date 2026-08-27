import { useMemo, useState } from 'react';

import { isClipEmpty, previewClip, resizeLayout } from '../../lib/layout/resize-layout';
import { validateLayout } from '../../lib/layout/validate-layout';
import { GRID_MAX, GRID_MIN, type LayoutRecord } from '../../lib/schemas/layout';
import { cellKey, sameCell } from '../../lib/sim';
import type { Cell, Layout, Station } from '../../lib/sim';
import { GridBoard } from './GridBoard';
import { IssueList } from './IssueList';
import { StationTable } from './StationTable';

type Props = {
  record: LayoutRecord;
};

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export function LayoutEditor({ record }: Props) {
  const [name, setName] = useState(record.name);
  const [layout, setLayout] = useState<Layout>(record.layout);
  const [settingStart, setSettingStart] = useState(false);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  // Recomputed on every edit — this is the live linter.
  const issues = useMemo(() => validateLayout(layout), [layout]);

  function edit(next: Layout) {
    setLayout(next);
    // Any edit invalidates a "Saved" badge; leaving it up would be a lie.
    setSave((current) => (current.status === 'saved' ? { status: 'idle' } : current));
  }

  function handleCellClick(cell: Cell) {
    if (settingStart) {
      edit({ ...layout, start: cell });
      setSettingStart(false);
      return;
    }

    edit({ ...layout, obstacles: toggleObstacle(layout, cell) });
  }

  function handleResize(width: number, height: number) {
    const preview = previewClip(layout, width, height);

    if (!isClipEmpty(preview)) {
      // Shrinking silently would destroy work the user cannot get back — there
      // is no undo in this milestone.
      const confirmed = window.confirm(describeClip(preview));

      if (!confirmed) return;
    }

    edit(resizeLayout(layout, width, height));
  }

  async function handleSave() {
    setSave({ status: 'saving' });

    try {
      const response = await fetch(`/api/layouts/${record.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, layout }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);

        setSave({ status: 'error', message: errorMessage(body, response.status) });
        return;
      }

      setSave({ status: 'saved' });
    } catch {
      setSave({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Layout name
          <input
            value={name}
            aria-label="Layout name"
            onChange={(event) => {
              setName(event.target.value);
              setSave((current) => (current.status === 'saved' ? { status: 'idle' } : current));
            }}
            className="w-64 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Width
          <input
            type="number"
            min={GRID_MIN}
            max={GRID_MAX}
            value={layout.width}
            aria-label="Grid width"
            onChange={(event) => {
              const width = clampSize(event.target.value);

              if (width !== null && width !== layout.width) handleResize(width, layout.height);
            }}
            className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Height
          <input
            type="number"
            min={GRID_MIN}
            max={GRID_MAX}
            value={layout.height}
            aria-label="Grid height"
            onChange={(event) => {
              const height = clampSize(event.target.value);

              if (height !== null && height !== layout.height) handleResize(layout.width, height);
            }}
            className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          />
        </label>

        <button
          type="button"
          onClick={() => setSettingStart((active) => !active)}
          aria-pressed={settingStart}
          className={`rounded px-3 py-1.5 text-sm ${
            settingStart ? 'bg-cyan-500 text-slate-950' : 'bg-slate-700'
          }`}
        >
          {settingStart ? 'Click a cell…' : 'Set start'}
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={save.status === 'saving'}
          className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {save.status === 'saving' ? 'Saving…' : 'Save'}
        </button>

        <SaveBadge state={save} />
      </div>

      <p className="text-sm text-slate-400">
        Click a cell to toggle an obstacle. Cells holding a station or the start
        cannot become obstacles.
      </p>

      <GridBoard layout={layout} settingStart={settingStart} onCellClick={handleCellClick} />

      <StationTable
        layout={layout}
        onChange={(stations: Station[]) => edit({ ...layout, stations })}
      />

      <IssueList issues={issues} />
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state.status === 'saved') {
    return <span className="text-sm text-emerald-400">Saved</span>;
  }

  if (state.status === 'error') {
    return <span className="text-sm text-red-400">{state.message}</span>;
  }

  return null;
}

/**
 * Toggles an obstacle, refusing cells that already hold something.
 *
 * Enforced here rather than by hiding the click, so the rule lives next to the
 * data it protects: an obstacle under a station would make the station
 * unreachable and is caught again by `validateLayout` on the server.
 */
function toggleObstacle(layout: Layout, cell: Cell): Cell[] {
  const key = cellKey(cell);

  if (layout.obstacles.some((obstacle) => cellKey(obstacle) === key)) {
    return layout.obstacles.filter((obstacle) => cellKey(obstacle) !== key);
  }

  if (sameCell(layout.start, cell)) return layout.obstacles;
  if (layout.stations.some((station) => sameCell(station.cell, cell))) return layout.obstacles;

  return [...layout.obstacles, cell];
}

function clampSize(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed)) return null;
  if (parsed < GRID_MIN || parsed > GRID_MAX) return null;

  return parsed;
}

function describeClip(preview: ReturnType<typeof previewClip>): string {
  const losses: string[] = [];

  if (preview.obstacles.length > 0) {
    losses.push(`${preview.obstacles.length} obstacle(s)`);
  }

  if (preview.stations.length > 0) {
    const names = preview.stations.map((station) => station.name || 'unnamed').join(', ');

    losses.push(`${preview.stations.length} station(s): ${names}`);
  }

  if (preview.movesStart) losses.push('the start cell will be moved inside the new bounds');

  return `Shrinking this grid will discard ${losses.join(' and ')}. Continue?`;
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };

    if (typeof error === 'string') return error;
  }

  return `Save failed (${status}).`;
}
