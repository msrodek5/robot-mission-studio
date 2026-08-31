/**
 * Captures the README screenshots, and the playback GIF, from a running app.
 *
 * Not a test — it asserts almost nothing and is not run by CI. It exists so the
 * images in the README can be regenerated after a UI change instead of being
 * re-shot by hand, which is how README screenshots end up two milestones stale.
 *
 * **It uses the real Anthropic API.** The whole point is a screenshot that
 * proves the planner and the postmortem work, and a stubbed diagnosis proves
 * only that the stub works. Two haiku calls per run.
 *
 * Usage:
 *   npm run build
 *   npm run e2e:serve &            # or set SHOTS_BASE_URL at an existing app
 *   node scripts/screenshots.mjs
 *
 * Writes PNGs to docs/screenshots/ and, if ffmpeg is on PATH or at FFMPEG_PATH,
 * docs/screenshots/playback.gif.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { chromium } from '@playwright/test';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

loadDotEnv();

const BASE_URL = process.env.SHOTS_BASE_URL ?? 'http://127.0.0.1:4331';
const OUT = resolve(process.cwd(), 'docs', 'screenshots');
const FRAMES = resolve(process.cwd(), 'docs', 'screenshots', '.frames');

/** `test_` prefix, same safety convention as the E2E users. */
const EMAIL = 'test_shots@example.com';
const PASSWORD = 'screenshot-password-9c1e';

/**
 * The floor plan the screenshots are taken on.
 *
 * Two staggered walls rather than a scatter of obstacles: the gap in the first
 * is at the bottom and the gap in the second is at the top, so the robot has to
 * detour twice and the visited trail in the playback shot reads as a route
 * somebody planned rather than a diagonal smear.
 */
const LAYOUT = {
  width: 14,
  height: 10,
  obstacles: [
    ...range(0, 7).map((y) => ({ x: 4, y })),
    ...range(3, 10).map((y) => ({ x: 9, y })),
  ],
  stations: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Shelf A',
      kind: 'shelf',
      cell: { x: 6, y: 8 },
      items: ['crate-a7'],
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Shelf B',
      kind: 'shelf',
      cell: { x: 6, y: 2 },
    },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Dock', kind: 'dock', cell: { x: 12, y: 1 } },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Charger',
      kind: 'charger',
      cell: { x: 12, y: 8 },
    },
  ],
  start: { x: 0, y: 0 },
};

const BRIEF =
  'Collect crate-a7 from Shelf A and deliver it to the Dock, then top the battery up at the Charger.';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const shots = [];

await main();

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const admin = adminClient();
  await recreateUser(admin);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1500, height: 1000 },
    // Retina-density output, so the PNGs still look sharp in a README on a
    // high-DPI screen rather than like a 2011 blog post.
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  page.on('pageerror', (error) => console.error('  [pageerror]', error.message));

  try {
    await logIn(page);
    const layoutId = await seedLayout(page);

    await shotLayoutEditor(page, layoutId);
    const missionId = await shotPlanner(page, layoutId);
    await shotPlanEditorAndLinter(page, missionId);
    const runUrl = await runMission(page);
    await shotPlayback(page, runUrl);
    await shotFailureAndPostmortem(page, layoutId);
  } finally {
    await context.close();
    await browser.close();
  }

  buildGif();
  rmSync(FRAMES, { recursive: true, force: true });

  console.log('\nWrote:');
  for (const name of shots) console.log(`  docs/screenshots/${name}`);
  console.log(`\nThe demo account ${EMAIL} and its rows are still in Supabase.`);
}

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------

async function shotLayoutEditor(page, layoutId) {
  await visit(page, `/app/layouts/${layoutId}`);
  await page.getByText('No issues. This layout is ready for a mission.').waitFor();

  await shoot(page, '01-layout-editor.png', { fullPage: true });
}

async function shotPlanner(page, layoutId) {
  await visit(page, `/app/layouts/${layoutId}/missions/new`);
  await page.getByLabel('Mission brief').fill(BRIEF);
  await page.getByLabel('Mission brief').blur();

  await shoot(page, '02-mission-planner.png');

  console.log('  calling the real planner…');
  await page.getByRole('button', { name: 'Generate plan' }).click();
  await page.getByRole('heading', { name: 'Edit plan' }).waitFor({ timeout: 60_000 });
  await waitForIslands(page);

  return new URL(page.url()).pathname.split('/').pop();
}

async function shotPlanEditorAndLinter(page, missionId) {
  await shoot(page, '03-plan-editor.png', { fullPage: true });

  // Break it the way the E2E suite does, so the linter shot is the real linter
  // and not a mocked-up error state.
  const placeIndex = await indexOfOp(page, 'PLACE');

  for (let index = placeIndex; index > 1; index -= 1) {
    await page.getByRole('button', { name: `Move step ${index} up` }).click();
  }

  await page.getByText('GRIPPER_EMPTY').first().waitFor();
  await shoot(page, '04-plan-editor-linter.png', { fullPage: true });

  // Put it back, then save, so the run below is of the plan as generated.
  const broken = await indexOfOp(page, 'PLACE');

  for (let index = broken; index < placeIndex; index += 1) {
    await page.getByRole('button', { name: `Move step ${index} down` }).click();
  }

  await page.getByText('No blocking issues. This plan is ready to run.').waitFor();
  await page.getByRole('button', { name: 'Save plan' }).click();
  await page.getByText('Saved.').waitFor();
}

async function runMission(page) {
  await page.getByRole('button', { name: 'Run mission' }).click();
  await page.getByText('Success.', { exact: true }).waitFor({ timeout: 30_000 });
  await waitForIslands(page);

  return page.url();
}

async function shotPlayback(page, runUrl) {
  const slider = page.getByLabel('Frame');
  const last = Number(await slider.getAttribute('max'));

  // Mid-run, carrying the crate: a trail behind the robot and a road ahead of
  // it. The final frame is a less interesting picture — the robot has stopped
  // and the whole grid is trail.
  await setFrame(page, Math.round(last * 0.62));
  await shoot(page, '05-playback-mid-run.png');

  await setFrame(page, last);
  await shoot(page, '06-playback-success.png', { fullPage: true });

  // Frame sequence for the GIF, over the region that actually moves.
  const clip = await animatedRegion(page);
  const step = Math.max(1, Math.round(last / 48));

  console.log(`  capturing ${Math.floor(last / step) + 1} frames for the GIF…`);

  let frame = 0;

  for (let index = 0; index <= last; index += step) {
    await setFrame(page, index);
    await page.screenshot({
      path: join(FRAMES, `f${String(frame).padStart(4, '0')}.png`),
      clip,
    });
    frame += 1;
  }
}

async function shotFailureAndPostmortem(page, layoutId) {
  await visit(page, `/app/layouts/${layoutId}`);
  await page.getByRole('button', { name: 'Run failing demo' }).click();
  await page.getByRole('alert').waitFor({ timeout: 30_000 });
  await waitForIslands(page);

  await shoot(page, '07-run-failure.png');

  console.log('  calling the real postmortem…');
  await page.getByRole('button', { name: 'Explain this failure' }).click();
  await page.getByRole('heading', { name: 'Suggested edits' }).waitFor({ timeout: 60_000 });

  await shoot(page, '08-failure-postmortem.png', { fullPage: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function shoot(page, name, options = {}) {
  mkdirSync(OUT, { recursive: true });
  // Animations off, so a hover transition mid-capture cannot smear a border.
  await page.screenshot({ path: join(OUT, name), animations: 'disabled', ...options });
  shots.push(name);
  console.log(`  ${name}`);
}

async function setFrame(page, index) {
  const slider = page.getByLabel('Frame');

  await slider.fill(String(index));
  await slider.dispatchEvent('change');
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector('input[type="range"]');
      return input !== null && input.value === String(expected);
    },
    index,
    { timeout: 5_000 },
  );
}

/**
 * Bounding box covering the grid and the panel beside it.
 *
 * The union of the two, not the row that contains them: the row is as wide as
 * the page and the GIF would be a third dead space. Measured rather than
 * hardcoded because the grid's size depends on the layout and the panel's on how
 * many steps the planner produced.
 */
async function animatedRegion(page) {
  const box = await page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]');
    // Both whole columns, so the frame cannot cut through the scrubber or the
    // last plan step: the grid's parent is the left column (grid, controls,
    // legend) and `Metrics` renders a bare <dl> whose parent is the right one
    // (metrics, step list).
    const leftColumn = grid.parentElement ?? grid;
    const rightColumn = document.querySelector('dl')?.parentElement;

    const a = leftColumn.getBoundingClientRect();
    const b = rightColumn?.getBoundingClientRect() ?? a;

    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);

    return {
      x: left,
      y: top,
      width: Math.max(a.right, b.right) - left,
      height: Math.max(a.bottom, b.bottom) - top,
    };
  });

  const pad = 14;

  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

async function indexOfOp(page, op) {
  const count = await page.getByRole('listitem').count();

  for (let index = 0; index < count; index += 1) {
    const select = page.getByLabel(`Step ${index} operation`);

    if ((await select.count()) === 1 && (await select.inputValue()) === op) return index;
  }

  throw new Error(`no ${op} step in the generated plan`);
}

async function visit(page, path) {
  await page.goto(path);
  await waitForIslands(page);
}

async function waitForIslands(page) {
  await page
    .locator('astro-island[ssr]')
    .waitFor({ state: 'detached', timeout: 15_000 })
    .catch(() => {});
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('astro-island')).every((island) =>
        Object.keys(island).some((key) => key.startsWith('__react')),
      ),
    undefined,
    { timeout: 15_000 },
  );
}

async function logIn(page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('heading', { name: 'Layouts', level: 1 }).waitFor();
}

async function seedLayout(page) {
  const created = await callApi(page, 'POST', '/api/layouts', { name: 'Aisle 7 — pick and drop' });
  const { layout } = JSON.parse(created.body);

  await callApi(page, 'PUT', `/api/layouts/${layout.id}`, {
    name: 'Aisle 7 — pick and drop',
    layout: LAYOUT,
  });

  return layout.id;
}

async function callApi(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      return { status: response.status, body: await response.text() };
    },
    { method, path, body },
  );
}

function adminClient() {
  return createClient(process.env.PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function recreateUser(admin) {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

  for (const user of data.users.filter((candidate) => candidate.email === EMAIL)) {
    await admin.auth.admin.deleteUser(user.id);
  }

  const { error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });

  if (error !== null) throw new Error(`could not create ${EMAIL}: ${error.message}`);
}

function buildGif() {
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const gif = join(OUT, 'playback.gif');

  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-framerate', '10',
        '-i', join(FRAMES, 'f%04d.png'),
        // Half scale (the frames are 2x) and a per-frame palette, which is what
        // keeps the cyan trail from banding into mud.
        '-vf', 'scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
        '-loop', '0',
        gif,
      ],
      { stdio: 'pipe' },
    );

    shots.push('playback.gif');
    console.log('  playback.gif');
  } catch (error) {
    console.warn(`  (skipped playback.gif — ${ffmpeg} not usable: ${error.message.split('\n')[0]})`);
  }
}

function range(from, to) {
  return Array.from({ length: to - from }, (_, index) => from + index);
}

function loadDotEnv() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;

    const value = match[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);

    process.env[match[1]] = quoted === null ? value : quoted[2];
  }
}
