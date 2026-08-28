import type { StepInput } from '../../lib/schemas/mission';
import type { Issue, Layout, StepOp } from '../../lib/sim';
import { STEP_OPS, stationLabel, withOp } from './step-ops';

type Props = {
  step: StepInput;
  index: number;
  total: number;
  layout: Layout;
  /** Issues whose `stepIndex` is this row. Rendered inline, under the fields. */
  issues: Issue[];
  onChange: (step: StepInput) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
};

/**
 * An emptied number input reports `NaN`, which `MissionSchema` rejects — so
 * clearing the field would turn a save into a 400 instead of a lint issue.
 * Zero keeps the plan storable and lets `validateMission` say what is wrong,
 * which is the editor's whole contract: a broken plan saves, it just cannot run.
 */
function numberOr(value: number, fallback: number): number {
  return Number.isNaN(value) ? fallback : value;
}

/**
 * One editable step.
 *
 * Station fields are always dropdowns over this layout's stations — never free
 * text. A typo'd station id is the single most common way to break a plan, and
 * it is the one class of error the editor can make structurally impossible
 * rather than merely report.
 */
export function StepRow({
  step,
  index,
  total,
  layout,
  issues,
  onChange,
  onMove,
  onDelete,
}: Props) {
  const errored = issues.some((issue) => issue.severity === 'error');

  return (
    <li
      data-step-index={index}
      className={`flex flex-col gap-2 rounded border px-3 py-2 ${
        errored ? 'border-red-500/50 bg-red-500/5' : 'border-slate-700'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 font-mono text-xs text-slate-500">{index}</span>

        <select
          value={step.op}
          aria-label={`Step ${index} operation`}
          onChange={(event) => onChange(withOp(step, event.target.value as StepOp, layout))}
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
        >
          {STEP_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>

        {'stationId' in step && (
          <select
            value={step.stationId}
            aria-label={`Step ${index} station`}
            onChange={(event) => onChange({ ...step, stationId: event.target.value })}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          >
            {/* A plan can name a station the layout no longer has — after the
                station was deleted, or straight from a model. The option below
                keeps that value visible and selected instead of silently
                snapping the step onto an unrelated station on first render. */}
            {layout.stations.every((station) => station.id !== step.stationId) && (
              <option value={step.stationId}>{step.stationId} — not in this layout</option>
            )}

            {layout.stations.map((station) => (
              <option key={station.id} value={station.id}>
                {stationLabel(station)}
              </option>
            ))}
          </select>
        )}

        {'item' in step && (
          <input
            value={step.item}
            aria-label={`Step ${index} item`}
            onChange={(event) => onChange({ ...step, item: event.target.value })}
            className="w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          />
        )}

        {step.op === 'CHARGE' && (
          <label className="flex items-center gap-1 text-xs text-slate-400">
            to
            <input
              type="number"
              min={0}
              max={100}
              value={step.toPercent}
              aria-label={`Step ${index} charge target`}
              onChange={(event) =>
                onChange({ ...step, toPercent: numberOr(event.target.valueAsNumber, 0) })
              }
              className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            />
            %
          </label>
        )}

        {step.op === 'WAIT' && (
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input
              type="number"
              min={1}
              value={step.ticks}
              aria-label={`Step ${index} ticks`}
              onChange={(event) =>
                onChange({ ...step, ticks: numberOr(event.target.valueAsNumber, 0) })
              }
              className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            />
            ticks
          </label>
        )}

        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move step ${index} up`}
            className="rounded bg-slate-700 px-2 py-1 text-xs disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={`Move step ${index} down`}
            className="rounded bg-slate-700 px-2 py-1 text-xs disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete step ${index}`}
            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300"
          >
            Delete
          </button>
        </span>
      </div>

      {issues.map((issue, issueIndex) => (
        <p
          key={`${issue.code}-${issueIndex}`}
          className={`text-xs ${issue.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}
        >
          <span className="font-mono">{issue.code}</span>
          <span className="ml-2">{issue.message}</span>
        </p>
      ))}
    </li>
  );
}
