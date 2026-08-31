/**
 * Environment plumbing for the E2E suite.
 *
 * Playwright is not Vite, so nothing here gets `.env` for free the way
 * `astro dev` and Vitest do. This module reads it once and only fills in names
 * that are not already set, so a value exported in the shell — or injected by
 * GitHub Actions from a secret — always wins over the file on disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Names the suite needs, with the reason each one is needed. */
const REQUIRED = {
  PUBLIC_SUPABASE_URL: 'the app and the admin client both talk to this project',
  PUBLIC_SUPABASE_ANON_KEY: 'the app signs the two test users in with it',
  SUPABASE_SERVICE_ROLE_KEY: 'creates and deletes the two test users, nothing else',
} as const;

let loaded = false;

/**
 * Merges `.env` into `process.env` without overwriting anything.
 *
 * A hand-rolled parser rather than a dotenv dependency: the sim core takes no
 * dependencies ever and the rest of the repo takes them only when asked, and
 * `KEY=value` with optional quotes is the whole grammar this file uses.
 */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;

  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);

    if (match === null) continue;

    const [, name, rawValue] = match;

    if (process.env[name] !== undefined) continue;

    process.env[name] = unquote(rawValue);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);

  return quoted === null ? trimmed : quoted[2];
}

export function requireEnv(name: keyof typeof REQUIRED): string {
  loadDotEnv();

  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set — ${REQUIRED[name]}. ` +
        'Fill it in .env locally, or add it to the repository secrets for CI.',
    );
  }

  return value;
}

/** Optional, unlike the three above: absent means "use the default". */
export function optionalEnv(name: string, fallback: string): string {
  loadDotEnv();

  const value = process.env[name];

  return value === undefined || value === '' ? fallback : value;
}
