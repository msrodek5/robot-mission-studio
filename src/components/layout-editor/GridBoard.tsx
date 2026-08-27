import { GridView } from '../grid/GridView';
import type { Cell, Layout } from '../../lib/sim';

type Props = {
  layout: Layout;
  /** When true, the next click sets the start cell instead of toggling. */
  settingStart: boolean;
  onCellClick: (cell: Cell) => void;
};

/**
 * The editor's grid: `GridView` in interactive mode.
 *
 * The renderer moved to `src/components/grid/GridView.tsx` in M4 so playback
 * draws the same picture instead of a second, drifting copy. This wrapper is
 * what keeps the editor's call sites — and the editing vocabulary of
 * `settingStart` — out of a component that also serves read-only playback.
 */
export function GridBoard({ layout, settingStart, onCellClick }: Props) {
  return (
    <GridView
      layout={layout}
      settingStart={settingStart}
      onCellClick={onCellClick}
      label="Layout grid"
    />
  );
}
