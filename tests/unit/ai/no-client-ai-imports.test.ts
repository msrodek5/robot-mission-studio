import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The one rule that keeps `ANTHROPIC_API_KEY` out of the browser.
 *
 * `src/lib/ai/**` reads server env and imports the Anthropic SDK. Astro will
 * happily bundle a module into a React island if a component imports it, and
 * the failure mode is silent: the build succeeds, the page works, and the key
 * ships to every visitor. Nothing else in the test suite would notice.
 *
 * So this walks the source tree instead of trusting review. `src/pages/api/**`
 * is exempt — endpoints are server-only and are exactly where the planner is
 * supposed to be called from.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCANNED_DIRS = ['src/components', 'src/pages'];
const EXEMPT = join('src', 'pages', 'api');
const EXTENSIONS = ['.ts', '.tsx', '.astro', '.js', '.jsx'];

/** Matches `from '…/lib/ai/…'`, `import '…'`, and `await import('…')`. */
const AI_IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]*\/lib\/ai(?:\/[^'"]*)?)['"]/g;

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const found: string[] = [];

  for (const entry of readdirSync(absolute, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;

    found.push(join(entry.parentPath, entry.name));
  }

  return found;
}

function isExempt(file: string): boolean {
  return relative(ROOT, file).startsWith(`${EXEMPT}${sep}`);
}

describe('server-only AI module', () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it('finds the files it claims to be scanning', () => {
    // A typo in a path would make the assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith('MissionPlanner.tsx'))).toBe(true);
    expect(files.some((file) => file.endsWith('generate.ts'))).toBe(true);
  });

  it('is never imported by a component or a non-API page', () => {
    const offenders = files
      .filter((file) => !isExempt(file))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        const hits = [...source.matchAll(AI_IMPORT)].map((match) => match[1]);

        return hits.map((hit) => `${relative(ROOT, file)} imports ${hit}`);
      });

    expect(offenders).toEqual([]);
  });

  it('still allows API endpoints to import it', () => {
    // The exemption is real, not theoretical — the generate endpoint uses it.
    const generate = readFileSync(join(ROOT, 'src/pages/api/missions/generate.ts'), 'utf8');

    expect(generate).toMatch(AI_IMPORT);
  });

  it('exempts a nested endpoint too, and scans it', () => {
    // The postmortem endpoint lives one directory deeper, under `[id]/`. Both
    // halves are worth pinning: the walker has to find it, and `isExempt` has to
    // still recognise it — a prefix check that only matched the top level would
    // turn this legitimate import into a suite-wide failure.
    const endpoint = join(ROOT, 'src/pages/api/runs/[id]/postmortem.ts');

    expect(files).toContain(endpoint);
    expect(isExempt(endpoint)).toBe(true);
    expect(readFileSync(endpoint, 'utf8')).toMatch(/lib\/ai\//);
  });

  it('keeps the browser-facing constants out of the AI module', () => {
    // The brief cap and the error codes are needed by the textarea and the
    // error card, so they live in schemas/. If they migrate into lib/ai, the
    // components have to import lib/ai and the rule above breaks.
    const planner = readFileSync(
      join(ROOT, 'src/components/mission/MissionPlanner.tsx'),
      'utf8',
    );

    expect(planner).toContain("from '../../lib/schemas/mission'");
  });
});
