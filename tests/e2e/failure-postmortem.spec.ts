/**
 * US-5 and US-6: a run that fails says why, where, and — once asked — what to
 * change. Then it remembers the answer.
 *
 * The failing demo is the right subject precisely because it is not
 * interesting: `MOVE_TO` a shelf, then `CHARGE` there. Only a charger charges,
 * so the run ends in `WRONG_STATION_KIND` at the second step on any layout with
 * a shelf, every time. A failure that needed a contrived battery budget to
 * reproduce would make this spec about the fixture instead of about the UI.
 *
 * The diagnosis text comes from `tests/fixtures/e2e/llm-stub.json` by way of the
 * stub Anthropic server, so the assertion below is on an exact string. The cache
 * assertion after the reload is the one that matters: it can only pass if the
 * first call wrote the postmortem to the run row.
 */

import { readFileSync } from 'node:fs';

import { callApi, reload, seedLayout, stockedLayout, visit, waitForIslands } from './support/app';
import { expect, test } from './support/fixtures';

const STUB = JSON.parse(
  readFileSync(new URL('../fixtures/e2e/llm-stub.json', import.meta.url), 'utf8'),
) as {
  postmortem: { diagnosis: string; suggestedEdits: { stepIndex: number; change: string }[] };
};

test('a failed run shows its failure, then explains it once and caches it', async ({ pageA }) => {
  const layoutId = await seedLayout(pageA, 'E2E failure postmortem', stockedLayout());

  await visit(pageA, `/app/layouts/${layoutId}`);
  await pageA.getByRole('button', { name: 'Run failing demo' }).click();

  // The click navigates to the run page, whose player is another island.
  await waitForIslands(pageA);

  // --- the failure ---------------------------------------------------------
  // The banner is the only `role="alert"` on a failed run page, so it is
  // addressed as one rather than by its wrapper.
  const banner = pageA.getByRole('alert');

  await expect(banner).toContainText('WRONG_STATION_KIND');
  // Step 2 of 2 — the CHARGE. One-based on screen, zero-based in the data.
  await expect(banner).toContainText('Failed at step 2.');

  // The plan panel marks the same step. `data-failing` exists for this
  // assertion: the highlight is otherwise carried by colour alone.
  const failingStep = pageA.locator('li[data-failing="true"]');

  await expect(failingStep).toHaveCount(1);
  await expect(failingStep).toHaveAttribute('data-step-index', '1');
  await expect(failingStep).toContainText('CHARGE');

  // --- the explanation -----------------------------------------------------
  await expect(pageA.getByRole('heading', { name: 'Why did this fail?' })).toBeVisible();
  await pageA.getByRole('button', { name: 'Explain this failure' }).click();

  await expect(pageA.getByText(STUB.postmortem.diagnosis)).toBeVisible();
  await expect(pageA.getByRole('heading', { name: 'Suggested edits' })).toBeVisible();
  await expect(pageA.getByText(STUB.postmortem.suggestedEdits[0].change)).toBeVisible();

  // Provenance rides along on the row. `e2e-stub-model` is what
  // `playwright.config.ts` pins `ANTHROPIC_MODEL` to, so seeing it here proves
  // the answer came from the stub and not from the real API.
  await expect(pageA.getByText('e2e-stub-model · postmortem-v1')).toBeVisible();

  // --- the cache -----------------------------------------------------------
  await reload(pageA);

  await expect(pageA.getByText(STUB.postmortem.diagnosis)).toBeVisible();

  // Cached means the card renders straight from the run row, so the button that
  // spends a model call is not on the page at all. If it came back, the second
  // visit would be billable.
  await expect(pageA.getByRole('button', { name: 'Explain this failure' })).toHaveCount(0);

  // Asking again is answered from the cache — same body, and `cached: true`.
  const runId = new URL(pageA.url()).pathname.split('/').pop();
  const again = await callApi(pageA, 'POST', `/api/runs/${runId}/postmortem`);

  expect(again.status).toBe(200);
  expect(JSON.parse(again.body)).toMatchObject({
    cached: true,
    postmortem: { diagnosis: STUB.postmortem.diagnosis },
  });
});
