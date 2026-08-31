/**
 * The repo's own lint step: the `CLAUDE.md` non-negotiables, mechanically.
 *
 * ## Why this and not ESLint
 *
 * M7 landed after feature freeze, and ESLint plus `typescript-eslint` plus the
 * Astro and a11y plugins is a dozen new packages and a rules debate on the last
 * weekend of the project. The rules that actually matter here are already
 * written down in `CLAUDE.md`, they are four, and three of them are the kind of
 * thing a regex is genuinely good at: a banned token, a banned comment, and a
 * module that must not import anything.
 *
 * So this is not a general-purpose linter and does not pretend to be one. It
 * enforces the four standing rules and nothing else; formatting and style are
 * left to review. `astro check` (`npm run typecheck`) is what actually type-checks
 * the code, and it runs in CI immediately after this.
 *
 * Exit code 1 on any violation, with `file:line rule` per finding.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const EXTENSIONS = ['.ts', '.tsx', '.astro', '.mjs'];
const ROOTS = ['src', 'tests', 'scripts'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.astro', '.vercel', '.auth']);

/**
 * The sim core. `CLAUDE.md` rule 1: pure, dependency-free, no clock, no
 * randomness, no I/O. Every golden test depends on this staying true, so it is
 * the one rule here with more than one check behind it.
 */
const SIM_PREFIX = `src${sep}lib${sep}sim${sep}`;

const findings = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) check(file);
}

report();

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function check(absolutePath) {
  const path = relative(ROOT, absolutePath);
  const source = readFileSync(absolutePath, 'utf8');
  const lines = source.split(/\r?\n/);

  const inSim = path.startsWith(SIM_PREFIX);
  // Non-null assertions are allowed in tests, and only there — a test that has
  // just built its own fixture knows more about it than the type does.
  const isTest = path.startsWith(`tests${sep}`);

  const code = stripComments(lines);

  lines.forEach((line, index) => {
    const at = { path, line: index + 1, text: line.trim() };
    const bare = code[index];

    // Rule 2, first half: no `any`. Matched in the positions a type annotation
    // actually occupies, so the word "any" in prose is not a violation.
    if (/(:\s*any\b|<\s*any\s*[,>]|\bas\s+any\b|\bany\[\]|\bArray<\s*any\s*>)/.test(bare)) {
      findings.push({ ...at, rule: 'no-any' });
    }

    // Rule 2, second half. `@ts-expect-error` is not on this list on purpose:
    // it fails when the error goes away, so it cannot rot silently.
    if (/@ts-(ignore|nocheck)\b/.test(line)) {
      findings.push({ ...at, rule: 'no-ts-ignore' });
    }

    // Rule 2, third half. `x!.y`, `f()!`, `a[0]!` — never `a !== b`, which has
    // whitespace before the bang, and never `!x`, which has none after it.
    if (!isTest && /[\w)\]]!(?=[.)\],;\s]|$)/.test(bare)) {
      findings.push({ ...at, rule: 'no-non-null-assertion' });
    }

    if (!inSim) return;

    // Rule 1. An import that leaves the directory is the failure mode this
    // catches: one `../schemas` and the "zero dependencies" claim is gone.
    const specifier = importSpecifier(bare);

    if (specifier !== null && (!specifier.startsWith('./') || specifier.includes('..'))) {
      findings.push({ ...at, rule: `sim-core-purity (imports ${specifier})` });
    }

    for (const [pattern, name] of [
      [/\bDate\.now\b|\bnew Date\b/, 'clock'],
      [/\bMath\.random\b/, 'randomness'],
      [/\bfetch\s*\(/, 'network'],
      [/\bprocess\.env\b|\bimport\.meta\.env\b/, 'environment'],
      [/\bconsole\./, 'logging'],
    ]) {
      if (pattern.test(bare)) {
        findings.push({ ...at, rule: `sim-core-purity (${name})` });
      }
    }
  });
}

/**
 * Blanks out comments, line by line, so a rule explained in prose is not a
 * violation of itself.
 *
 * This file is mostly a description of things you must not write, and so is much
 * of `src/lib/sim` — the header there names `Math.random` in order to forbid it.
 * Without this, the purity rule would fail on its own documentation.
 *
 * Deliberately naive about string literals: a `//` inside one truncates the rest
 * of the line, which can only ever hide a violation from a *later* column on the
 * same line. That is a false negative in a corner this codebase does not have,
 * and it is preferable to the alternative of writing a tokeniser here.
 */
function stripComments(lines) {
  let inBlock = false;

  return lines.map((line) => {
    let output = '';
    let index = 0;

    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', index);

        if (end === -1) return output;

        inBlock = false;
        index = end + 2;
        continue;
      }

      const lineComment = line.indexOf('//', index);
      const blockStart = line.indexOf('/*', index);

      if (lineComment !== -1 && (blockStart === -1 || lineComment < blockStart)) {
        return output + line.slice(index, lineComment);
      }

      if (blockStart === -1) return output + line.slice(index);

      output += line.slice(index, blockStart);
      inBlock = true;
      index = blockStart + 2;
    }

    return output;
  });
}

function importSpecifier(line) {
  const match = /(?:^|\s)(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]/.exec(line);

  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function* walk(directory) {
  let entries;

  try {
    entries = readdirSync(directory);
  } catch {
    // A root that does not exist is not a lint error.
    return;
  }

  for (const entry of entries.sort()) {
    if (SKIP_DIRECTORIES.has(entry)) continue;

    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      yield path;
    }
  }
}

function report() {
  if (findings.length === 0) {
    process.stdout.write('lint-rules: no violations of the CLAUDE.md standing rules.\n');
    return;
  }

  for (const finding of findings) {
    process.stdout.write(`${finding.path}:${finding.line}  ${finding.rule}\n    ${finding.text}\n`);
  }

  const label = findings.length === 1 ? 'violation' : 'violations';

  process.stdout.write(`\nlint-rules: ${findings.length} ${label}.\n`);
  process.exit(1);
}
