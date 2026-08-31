/**
 * US-1 through US-5, end to end: draw a layout, prove it survives a reload,
 * plan a mission from a brief, run it, watch it succeed.
 *
 * The only spec that builds a layout through the editor. Everything it touches
 * is addressed by role or accessible name — the grid cells carry labels like
 * `Cell 4, 3 — obstacle`, which is both how a screen reader reads them and how
 * this test clicks them, so a markup change that breaks the locator has broken
 * the accessibility too.
 */

import { DEMO_ITEM, reload, visit, waitForIslands } from './support/app';
import { expect, test } from './support/fixtures';

const LAYOUT_NAME = 'E2E happy path warehouse';

/** Cells the test turns into obstacles, and later checks are still obstacles. */
const OBSTACLES = [
  { x: 4, y: 3 },
  { x: 4, y: 4 },
];

const SHELF = { name: 'Shelf A', x: 7, y: 4 };
const DOCK = { name: 'Dock', x: 1, y: 8 };
const START = { x: 0, y: 0 };

test('draw a layout, plan a mission from a brief, run it to success', async ({ pageA }) => {
  // --- create -------------------------------------------------------------
  await visit(pageA, '/app/layouts');
  await pageA.getByLabel('New layout name').fill(LAYOUT_NAME);
  await pageA.getByRole('button', { name: 'Create' }).click();

  // Creating a layout drops the user straight into its editor. Waiting on the
  // URL first is load-bearing: `getByLabel` matches a substring, so
  // `Layout name` also matches the list's `New layout name` field — which holds
  // this same value — and the editor assertion would pass without ever leaving
  // the list.
  await expect(pageA).toHaveURL(/\/app\/layouts\/[0-9a-f-]{36}$/);
  await waitForIslands(pageA);
  await expect(pageA.getByLabel('Layout name', { exact: true })).toHaveValue(LAYOUT_NAME);

  // --- draw ---------------------------------------------------------------
  for (const cell of OBSTACLES) {
    await pageA.getByRole('button', { name: cellName(cell) }).click();
  }

  await addStation(pageA, 'shelf', SHELF);
  await addStation(pageA, 'dock', DOCK);

  // The start defaults to 0,0 and is already there, but setting it explicitly is
  // what US-2 promises and it is the one editor mode with its own state.
  await pageA.getByRole('button', { name: 'Set start' }).click();
  await pageA.getByRole('button', { name: cellName(START) }).click();

  await expect(pageA.getByText('No issues. This layout is ready for a mission.')).toBeVisible();

  // --- save and reload ----------------------------------------------------
  await pageA.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(pageA.getByText('Saved', { exact: true })).toBeVisible();

  await reload(pageA);

  // The layout renders identically: same name, same dimensions, same obstacles,
  // same stations, same start. Read off the grid's own labels rather than a
  // snapshot, so a failure names the cell that changed.
  await expect(pageA.getByLabel('Layout name', { exact: true })).toHaveValue(LAYOUT_NAME);
  await expect(pageA.getByLabel('Grid width')).toHaveValue('10');
  await expect(pageA.getByLabel('Grid height')).toHaveValue('10');

  for (const cell of OBSTACLES) {
    await expect(pageA.getByRole('button', { name: `${cellName(cell)} — obstacle` })).toBeVisible();
  }

  await expect(
    pageA.getByRole('button', { name: `Cell ${SHELF.x}, ${SHELF.y} — shelf "${SHELF.name}"` }),
  ).toBeVisible();
  await expect(
    pageA.getByRole('button', { name: `Cell ${DOCK.x}, ${DOCK.y} — dock "${DOCK.name}"` }),
  ).toBeVisible();
  await expect(
    pageA.getByRole('button', { name: `${cellName(START)} — start` }),
  ).toBeVisible();
  await expect(pageA.getByText('No issues. This layout is ready for a mission.')).toBeVisible();

  // --- stock the shelf ----------------------------------------------------
  // `PICK` fails with ITEM_NOT_PRESENT against an empty shelf, and the station
  // table has no items column — so this button is the only way a layout drawn in
  // the editor can ever run a successful pick.
  const stockButton = pageA.getByRole('button', { name: `Stock a shelf with “${DEMO_ITEM}”` });
  const runDemo = pageA.getByRole('button', { name: 'Run demo mission' });

  await expect(runDemo).toBeDisabled();
  await stockButton.click();

  // Wait on the *positive* signal — the demo becoming runnable — not on the
  // stock button disappearing. That button relabels itself to "Saving…" the
  // instant it is pressed, so "gone" is true a beat before the save has
  // happened, and clicking on from there raced the reload it triggers.
  await expect(runDemo).toBeEnabled();
  await waitForIslands(pageA);
  await expect(stockButton).toHaveCount(0);

  // --- plan ---------------------------------------------------------------
  await pageA.getByRole('link', { name: 'Plan with AI' }).click();
  await expect(pageA).toHaveURL(/\/missions\/new$/);
  await waitForIslands(pageA);
  await expect(pageA.getByRole('heading', { name: 'Plan a mission' })).toBeVisible();

  await pageA
    .getByLabel('Mission brief')
    .fill(`Fetch the "${DEMO_ITEM}" from ${SHELF.name} and leave it at the ${DOCK.name}.`);
  await pageA.getByRole('button', { name: 'Generate plan' }).click();

  await waitForIslands(pageA);

  // Lands in the plan editor on the persisted mission — the generated plan is a
  // real row, which is why the stub sits behind the SDK rather than in front of
  // this endpoint.
  await expect(pageA.getByRole('heading', { name: 'Edit plan' })).toBeVisible();
  await expect(pageA.getByText('AI-generated')).toBeVisible();
  await expect(pageA.getByRole('heading', { name: /^Steps \(4/ })).toBeVisible();
  await expect(
    pageA.getByText('No blocking issues. This plan is ready to run.'),
  ).toBeVisible();

  // --- run ----------------------------------------------------------------
  await pageA.getByRole('button', { name: 'Run mission' }).click();
  await waitForIslands(pageA);

  // `Success.` is its own element inside the banner; the totals are the sibling
  // text. Asserted separately because Playwright's text engine resolves to the
  // smallest matching element, and that element is the <strong>.
  await expect(pageA.getByText('Success.', { exact: true })).toBeVisible();
  await expect(
    pageA.getByText(/\d+ ticks, [\d.]+ cells, [\d.]+% battery left\./),
  ).toBeVisible();

  await expect(pageA.getByRole('grid', { name: 'Run playback grid' })).toBeVisible();
  await expect(pageA.getByRole('heading', { name: 'Plan' })).toBeVisible();

  // The live metrics panel, which is what the scrubber drives.
  for (const term of ['Tick', 'Distance', 'Battery', 'Carrying']) {
    await expect(pageA.getByText(term, { exact: true })).toBeVisible();
  }

  // Playing to the end must not change the outcome — frames are recomputed from
  // layout + plan + seed, so the final frame *is* the persisted result. 4x first
  // so this waits on a second of animation rather than four.
  await pageA.getByRole('button', { name: 'Playback speed 1x' }).click();
  // `exact` because the accessible-name match is a substring by default, and
  // "Play" is one of "Playback speed 4x".
  await pageA.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(pageA.getByRole('button', { name: 'Step forward' })).toBeDisabled({
    timeout: 20_000,
  });
  await expect(pageA.getByText('Success.', { exact: true })).toBeVisible();

  // A failed run would have offered a postmortem. A successful one must not:
  // there is nothing to diagnose and the endpoint answers 409 if asked.
  await expect(pageA.getByRole('button', { name: 'Explain this failure' })).toHaveCount(0);

  // --- the run is durable -------------------------------------------------
  const runUrl = pageA.url();
  await reload(pageA);
  await expect(pageA.getByText('Success.', { exact: true })).toBeVisible();
  expect(pageA.url()).toBe(runUrl);
});

function cellName(cell: { x: number; y: number }): string {
  return `Cell ${cell.x}, ${cell.y}`;
}

async function addStation(
  page: import('@playwright/test').Page,
  kind: 'shelf' | 'dock' | 'charger',
  station: { name: string; x: number; y: number },
): Promise<void> {
  await page.getByLabel('New station name').fill(station.name);
  await page.getByLabel('New station kind').selectOption(kind);
  await page.getByLabel('New station x').fill(String(station.x));
  await page.getByLabel('New station y').fill(String(station.y));
  await page.getByRole('button', { name: 'Add station' }).click();

  await expect(
    page.getByRole('button', { name: `Cell ${station.x}, ${station.y} — ${kind} "${station.name}"` }),
  ).toBeVisible();
}
