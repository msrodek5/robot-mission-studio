import { useState } from 'react';

import { STATION_KINDS } from '../../lib/schemas/layout';
import type { Layout, Station, StationKind } from '../../lib/sim';

type Props = {
  layout: Layout;
  onChange: (stations: Station[]) => void;
};

/**
 * Station list plus an add form.
 *
 * Editing is inline and unvalidated here on purpose — a half-typed station is
 * allowed to exist, and `validateLayout` is what tells the user it is not
 * finished yet. Blocking the keystroke instead would make the name field
 * impossible to clear.
 */
export function StationTable({ layout, onChange }: Props) {
  const [draftName, setDraftName] = useState('');
  const [draftKind, setDraftKind] = useState<StationKind>('shelf');
  const [draftX, setDraftX] = useState(0);
  const [draftY, setDraftY] = useState(0);

  function addStation() {
    const station: Station = {
      id: crypto.randomUUID(),
      name: draftName.trim(),
      kind: draftKind,
      cell: { x: draftX, y: draftY },
    };

    onChange([...layout.stations, station]);
    setDraftName('');
  }

  function updateStation(index: number, patch: Partial<Station>) {
    onChange(
      layout.stations.map((station, i) => (i === index ? { ...station, ...patch } : station)),
    );
  }

  function removeStation(index: number) {
    onChange(layout.stations.filter((_, i) => i !== index));
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide uppercase">Stations</h2>

      {layout.stations.length === 0 ? (
        <p className="text-sm text-slate-400">No stations yet. Add one below.</p>
      ) : (
        <table className="w-full max-w-2xl text-sm">
          <thead className="text-left text-slate-400">
            <tr>
              <th className="py-1 pr-2 font-medium">Name</th>
              <th className="py-1 pr-2 font-medium">Kind</th>
              <th className="py-1 pr-2 font-medium">X</th>
              <th className="py-1 pr-2 font-medium">Y</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {layout.stations.map((station, index) => (
              <tr key={station.id}>
                <td className="py-1 pr-2">
                  <input
                    value={station.name}
                    aria-label={`Station ${index + 1} name`}
                    onChange={(event) => updateStation(index, { name: event.target.value })}
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1"
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    value={station.kind}
                    aria-label={`Station ${index + 1} kind`}
                    onChange={(event) =>
                      updateStation(index, { kind: event.target.value as StationKind })
                    }
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
                  >
                    {STATION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <CoordInput
                    value={station.cell.x}
                    max={layout.width - 1}
                    label={`Station ${index + 1} x`}
                    onChange={(x) => updateStation(index, { cell: { ...station.cell, x } })}
                  />
                </td>
                <td className="py-1 pr-2">
                  <CoordInput
                    value={station.cell.y}
                    max={layout.height - 1}
                    label={`Station ${index + 1} y`}
                    onChange={(y) => updateStation(index, { cell: { ...station.cell, y } })}
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => removeStation(index)}
                    className="rounded bg-slate-700 px-2 py-1 text-xs"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Name
          <input
            value={draftName}
            aria-label="New station name"
            onChange={(event) => setDraftName(event.target.value)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Kind
          <select
            value={draftKind}
            aria-label="New station kind"
            onChange={(event) => setDraftKind(event.target.value as StationKind)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          >
            {STATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          X
          <CoordInput
            value={draftX}
            max={layout.width - 1}
            label="New station x"
            onChange={setDraftX}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Y
          <CoordInput
            value={draftY}
            max={layout.height - 1}
            label="New station y"
            onChange={setDraftY}
          />
        </label>

        <button type="button" onClick={addStation} className="rounded bg-cyan-600 px-3 py-1.5 text-sm">
          Add station
        </button>
      </div>
    </section>
  );
}

type CoordProps = {
  value: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
};

function CoordInput({ value, max, label, onChange }: CoordProps) {
  return (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      aria-label={label}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);

        // An empty or half-typed field parses to NaN. Holding the previous value
        // keeps the layout parseable rather than writing NaN into a cell.
        if (Number.isInteger(next)) onChange(next);
      }}
      className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
    />
  );
}
