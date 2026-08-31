/**
 * Writes the CI job summary: unit test counts and sim-core line coverage.
 *
 * The interesting number is not the headline percentage — it is the sim core's,
 * because that is the module where a wrong answer is silent. A bad path or an
 * off-by-one in the battery arithmetic produces a run that looks plausible and
 * is wrong, and only a test catches it. So the summary reports `src/lib/sim`
 * separately from everything else rather than averaging the two into a figure
 * that tells you nothing about either.
 *
 * Reads `reports/unit.json` (vitest's json reporter) and
 * `coverage/coverage-summary.json` (the `json-summary` coverage reporter). Both
 * are produced by the `npx vitest run --coverage` step in `.github/workflows/ci.yml`.
 *
 * Emits markdown on stdout. Missing inputs are reported in the summary rather
 * than thrown, because a summary step that fails the job would mask whichever
 * real failure stopped the reports from being written in the first place.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Not under `test-results/`. Playwright empties its output directory when it
 * starts, so a unit report written there is gone by the time the E2E step
 * finishes — which showed up as "no report" in the job summary while the vitest
 * log cheerfully said it had written one.
 */
const UNIT_RESULTS = 'reports/unit.json';
const COVERAGE_SUMMARY = 'coverage/coverage-summary.json';

/** Paths under this prefix are the sim core. Matched on both path separators. */
const SIM_PREFIX = ['src', 'lib', 'sim'].join(sep);

process.stdout.write(render());

function render() {
  return ['## Robot Mission Studio — CI', '', unitSection(), '', coverageSection(), ''].join('\n');
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

function unitSection() {
  const results = readJson(UNIT_RESULTS);

  if (results === null) {
    return `### Unit tests\n\nNo report at \`${UNIT_RESULTS}\` — the vitest step did not get that far.`;
  }

  const { numTotalTests, numPassedTests, numFailedTests, numPendingTests } = results;

  // `testResults` is one entry per file; `numTotalTestSuites` counts `describe`
  // blocks, which is four times larger and reads as a wrong number.
  const files = results.testResults?.length ?? 0;

  const verdict = numFailedTests > 0 ? `❌ ${numFailedTests} failed` : '✅ all passing';

  return [
    '### Unit tests',
    '',
    `${verdict} — **${numPassedTests} / ${numTotalTests}** across ${files} test files.`,
    '',
    '| Passed | Failed | Skipped | Total |',
    '| --: | --: | --: | --: |',
    `| ${numPassedTests} | ${numFailedTests} | ${numPendingTests ?? 0} | ${numTotalTests} |`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function coverageSection() {
  const summary = readJson(COVERAGE_SUMMARY);

  if (summary === null) {
    return `### Coverage\n\nNo report at \`${COVERAGE_SUMMARY}\` — the coverage step did not get that far.`;
  }

  const sim = { total: 0, covered: 0 };
  const rest = { total: 0, covered: 0 };
  const simFiles = [];

  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;

    const bucket = key.includes(SIM_PREFIX) ? sim : rest;

    bucket.total += entry.lines.total;
    bucket.covered += entry.lines.covered;

    if (bucket === sim) {
      simFiles.push({ name: key.split(sep).pop(), lines: entry.lines });
    }
  }

  const overall = summary.total.lines;

  return [
    '### Coverage — lines',
    '',
    '| Area | Covered | Lines | % |',
    '| :-- | --: | --: | --: |',
    row('**`src/lib/sim` (the sim core)**', sim),
    row('Everything else under `src/lib`', rest),
    row('All measured files', { total: overall.total, covered: overall.covered }),
    '',
    '<details><summary>Sim core, file by file</summary>',
    '',
    '| File | Covered | Lines | % |',
    '| :-- | --: | --: | --: |',
    ...simFiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => row(`\`${file.name}\``, file.lines)),
    '',
    '</details>',
    '',
    'Coverage is measured over `src/lib/**` only. Pages and components are',
    'exercised by the Playwright suite instead — see the README.',
  ].join('\n');
}

function row(label, lines) {
  return `| ${label} | ${lines.covered} | ${lines.total} | ${percent(lines)} |`;
}

function percent({ total, covered }) {
  return total === 0 ? 'n/a' : `${((covered / total) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function readJson(path) {
  const absolute = resolve(process.cwd(), path);

  if (!existsSync(absolute)) return null;

  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}
