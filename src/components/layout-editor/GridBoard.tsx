import { cellKey } from '../../lib/sim';
import type { Cell, Layout, Station } from '../../lib/sim';

type Props = {
  layout: Layout;
  /** When true, the next click sets the start cell instead of toggling. */
  settingStart: boolean;
  onCellClick: (cell: Cell) => void;
};

const KIND_LABEL: Record<Station['kind'], string> = {
  dock: 'D',
  shelf: 'S',
  charger: 'C',
};

/**
 * The grid, as a CSS grid of buttons — one per cell.
 *
 * Deliberately not a canvas: at 20x20 that is 400 buttons, which the browser
 * handles fine and which comes with focus, keyboard access, and hit testing for
 * free. A canvas would mean reimplementing all three.
 */
export function GridBoard({ layout, settingStart, onCellClick }: Props) {
  const obstacles = new Set(layout.obstacles.map(cellKey));
  const stationsByCell = new Map(layout.stations.map((station) => [cellKey(station.cell), station]));
  const startKey = cellKey(layout.start);

  // Rows outer, columns inner, so reading order matches the visual grid.
  const rows = Array.from({ length: layout.height }, (_, y) => y);
  const columns = Array.from({ length: layout.width }, (_, x) => x);

  return (
    <div
      className="inline-grid gap-px bg-slate-700 p-px"
      style={{ gridTemplateColumns: `repeat(${layout.width}, 1.75rem)` }}
      role="grid"
      aria-label="Layout grid"
    >
      {rows.map((y) =>
        columns.map((x) => {
          const cell = { x, y };
          const key = cellKey(cell);
          const station = stationsByCell.get(key);
          const isObstacle = obstacles.has(key);
          const isStart = key === startKey;

          return (
            <button
              key={key}
              type="button"
              onClick={() => onCellClick(cell)}
              title={describe(cell, station, isObstacle, isStart)}
              aria-label={describe(cell, station, isObstacle, isStart)}
              className={[
                'h-7 w-7 text-[0.6rem] font-semibold leading-none',
                settingStart ? 'cursor-crosshair' : 'cursor-pointer',
                backgroundFor(isObstacle, isStart, station),
              ].join(' ')}
            >
              {labelFor(station, isStart)}
            </button>
          );
        }),
      )}
    </div>
  );
}

function backgroundFor(
  isObstacle: boolean,
  isStart: boolean,
  station: Station | undefined,
): string {
  // Start wins over station wins over obstacle, matching the click rules: a
  // cell holding a station or the start can never also be an obstacle.
  if (isStart) return 'bg-cyan-500 text-slate-950';
  if (station) return 'bg-amber-400 text-slate-950';
  if (isObstacle) return 'bg-slate-500';

  return 'bg-slate-900 hover:bg-slate-800';
}

function labelFor(station: Station | undefined, isStart: boolean): string {
  if (isStart) return '@';

  return station ? KIND_LABEL[station.kind] : '';
}

function describe(
  cell: Cell,
  station: Station | undefined,
  isObstacle: boolean,
  isStart: boolean,
): string {
  const parts = [`Cell ${cell.x}, ${cell.y}`];

  if (isStart) parts.push('start');
  if (station) parts.push(`${station.kind} "${station.name || 'unnamed'}"`);
  if (isObstacle) parts.push('obstacle');

  return parts.join(' — ');
}
