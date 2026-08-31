import { cellKey } from '../../lib/sim';
import type { Cell, Layout, Station } from '../../lib/sim';

/**
 * Playback decoration drawn on top of a layout.
 *
 * Optional so the editor can render the same grid with no robot in sight — the
 * editor and the player differ only by this object and by whether cells are
 * clickable, which is the entire reason there is one renderer instead of two.
 */
export type GridOverlay = {
  /** Cell the robot occupies right now, or `null` when nothing is running. */
  robot: Cell | null;
  /** `cellKey`s the robot has already stood on, up to the current frame. */
  visited: ReadonlySet<string>;
  /** Item in the gripper. Drawn as a marker on the robot's cell. */
  carrying: string | null;
};

type Props = {
  layout: Layout;
  /** Omitted in the editor; supplied by playback. */
  overlay?: GridOverlay;
  /** Interactive when provided: every cell becomes a button. */
  onCellClick?: (cell: Cell) => void;
  /** Editor affordance — swaps the cursor while the next click sets `start`. */
  settingStart?: boolean;
  /** Accessible name for the grid container. */
  label?: string;
};

const KIND_LABEL: Record<Station['kind'], string> = {
  dock: 'D',
  shelf: 'S',
  charger: 'C',
};

const EMPTY_OVERLAY: GridOverlay = {
  robot: null,
  visited: new Set<string>(),
  carrying: null,
};

/**
 * The grid, as a CSS grid of one element per cell.
 *
 * Deliberately not a canvas: at 20x20 that is 400 nodes, which the browser
 * handles fine and which comes with focus, keyboard access, hit testing, and
 * screen-reader labels for free. A canvas would mean reimplementing all four,
 * twice, since playback needs the same picture the editor draws.
 *
 * Read-only mode renders `div`s rather than disabled buttons: a playback grid is
 * a picture, and 400 focusable-but-dead controls would wreck tab order.
 */
export function GridView({
  layout,
  overlay = EMPTY_OVERLAY,
  onCellClick,
  settingStart = false,
  label = 'Layout grid',
}: Props) {
  const obstacles = new Set(layout.obstacles.map(cellKey));
  const stationsByCell = new Map(layout.stations.map((station) => [cellKey(station.cell), station]));
  const startKey = cellKey(layout.start);
  const robotKey = overlay.robot === null ? null : cellKey(overlay.robot);

  // Rows outer, columns inner, so reading order matches the visual grid.
  const rows = Array.from({ length: layout.height }, (_, y) => y);
  const columns = Array.from({ length: layout.width }, (_, x) => x);

  return (
    <div
      // `self-start` is load-bearing, not decoration. Both call sites put this
      // inside a flex column, which blockifies `inline-grid` and stretches it to
      // the container's width — so the `bg-slate-700` gap colour spilled out as
      // a grey slab to the right of the last column on any grid narrower than
      // its container, which is most of them.
      className="inline-grid gap-px self-start bg-slate-700 p-px"
      style={{ gridTemplateColumns: `repeat(${layout.width}, 1.75rem)` }}
      role="grid"
      aria-label={label}
    >
      {rows.map((y) =>
        columns.map((x) => {
          const cell = { x, y };
          const key = cellKey(cell);

          const state: CellState = {
            cell,
            station: stationsByCell.get(key),
            isObstacle: obstacles.has(key),
            isStart: key === startKey,
            isRobot: key === robotKey,
            isVisited: overlay.visited.has(key),
            carrying: key === robotKey ? overlay.carrying : null,
          };

          const description = describe(state);
          const className = [
            'relative h-7 w-7 text-[0.6rem] font-semibold leading-none',
            backgroundFor(state, onCellClick !== undefined),
            state.isVisited && !state.isRobot ? 'ring-1 ring-cyan-400/50 ring-inset' : '',
          ]
            .filter((part) => part !== '')
            .join(' ');

          const content = (
            <>
              {labelFor(state)}
              {state.carrying === null ? null : (
                // The item name never fits in 28px; the marker says "holding
                // something" and the panel beside the grid names it.
                <span
                  aria-hidden="true"
                  className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-300"
                />
              )}
            </>
          );

          if (onCellClick === undefined) {
            return (
              <div
                key={key}
                role="gridcell"
                title={description}
                aria-label={description}
                className={`${className} flex items-center justify-center`}
              >
                {content}
              </div>
            );
          }

          return (
            <button
              key={key}
              type="button"
              onClick={() => onCellClick(cell)}
              title={description}
              aria-label={description}
              className={`${className} ${settingStart ? 'cursor-crosshair' : 'cursor-pointer'}`}
            >
              {content}
            </button>
          );
        }),
      )}
    </div>
  );
}

type CellState = {
  cell: Cell;
  station: Station | undefined;
  isObstacle: boolean;
  isStart: boolean;
  isRobot: boolean;
  isVisited: boolean;
  carrying: string | null;
};

function backgroundFor(state: CellState, interactive: boolean): string {
  // Robot wins over start wins over station wins over obstacle, matching the
  // editor's click rules: a cell holding a station or the start can never also
  // be an obstacle, and the robot is the thing the eye needs to find first.
  if (state.isRobot) return 'bg-emerald-400 text-slate-950';
  if (state.isStart) return 'bg-cyan-500 text-slate-950';
  if (state.station) return 'bg-amber-400 text-slate-950';
  if (state.isObstacle) return 'bg-slate-500';
  if (state.isVisited) return 'bg-cyan-900/60';

  // Only empty cells get a hover tint, and only where clicking does something.
  return interactive ? 'bg-slate-900 hover:bg-slate-800' : 'bg-slate-900';
}

function labelFor(state: CellState): string {
  if (state.isRobot) return 'R';
  if (state.isStart) return '@';

  return state.station ? KIND_LABEL[state.station.kind] : '';
}

function describe(state: CellState): string {
  const parts = [`Cell ${state.cell.x}, ${state.cell.y}`];

  if (state.isRobot) parts.push('robot');
  if (state.carrying !== null) parts.push(`carrying "${state.carrying}"`);
  if (state.isStart) parts.push('start');
  if (state.station) parts.push(`${state.station.kind} "${state.station.name || 'unnamed'}"`);
  if (state.isObstacle) parts.push('obstacle');
  if (state.isVisited && !state.isRobot) parts.push('visited');

  return parts.join(' — ');
}
