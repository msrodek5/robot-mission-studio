import type { LayoutIssue } from '../../lib/layout/validate-layout';

type Props = {
  issues: LayoutIssue[];
};

/**
 * The live linter's output.
 *
 * Issues never block saving, so this is the only thing telling the user their
 * layout will not run. It stays visible rather than appearing in a toast.
 */
export function IssueList({ issues }: Props) {
  if (issues.length === 0) {
    return (
      <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
        No issues. This layout is ready for a mission.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-wide uppercase">
        {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
      </h2>

      <ul className="flex flex-col gap-1">
        {issues.map((issue, index) => (
          <li
            // Codes repeat across stations, so the index is part of the identity.
            key={`${issue.code}-${issue.stationIndex ?? 'layout'}-${index}`}
            className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
          >
            <span className="font-mono text-xs text-red-400">{issue.code}</span>
            <span className="ml-2">{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
