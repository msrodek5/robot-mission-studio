/**
 * US-4 — the plan editor's live linter, and the gate it drives.
 *
 * The scenario is the one mistake the editor exists to catch: a `PLACE` moved
 * above the `PICK` that fills the gripper. `validateMission` is the same pure
 * function the planner gates model output with and the same one the server
 * re-runs on save, so an issue appearing here is the same issue that would have
 * stopped a generated plan.
 *
 * Note what is asserted about the Run button. A broken plan and an unsaved plan
 * are both un-runnable, but for different reasons and with different fixes, so
 * this reads the reason rather than only the disabled attribute — otherwise it
 * would pass just as happily if the linter did nothing and the dirty flag did
 * all the work.
 */

import type { Locator, Page } from '@playwright/test';

import { runDemoMission, seedLayout, stockedLayout, visit } from './support/app';
import { expect, test } from './support/fixtures';

test('reordering a PLACE above its PICK blocks the run until it is fixed', async ({ pageA }) => {
  const layoutId = await seedLayout(pageA, 'E2E plan editor', stockedLayout());

  // The demo mission is the deterministic four-step pick-and-place:
  // MOVE_TO, PICK, MOVE_TO, PLACE. Created through the same endpoint the demo
  // button calls, because this spec is about the editor, not about the planner.
  const { missionId } = await runDemoMission(pageA, layoutId, 'success');

  await visit(pageA, `/app/missions/${missionId}`);
  await expect(pageA.getByRole('heading', { name: 'Edit plan' })).toBeVisible();

  const runButton = pageA.getByRole('button', { name: 'Run mission' });
  const saveButton = pageA.getByRole('button', { name: 'Save plan' });

  // --- baseline ------------------------------------------------------------
  await expect(pageA.getByText('No blocking issues. This plan is ready to run.')).toBeVisible();
  await expect(runButton).toBeEnabled();
  await expectOps(pageA, ['MOVE_TO', 'PICK', 'MOVE_TO', 'PLACE']);

  // --- break it ------------------------------------------------------------
  // Two clicks: PLACE from index 3 to index 2, then from 2 to 1 — above the
  // PICK, which is now at 2. The labels renumber after every move, which is why
  // the second click names a different step than the first.
  await pageA.getByRole('button', { name: 'Move step 3 up' }).click();
  await pageA.getByRole('button', { name: 'Move step 2 up' }).click();

  await expectOps(pageA, ['MOVE_TO', 'PLACE', 'PICK', 'MOVE_TO']);

  // The issue sits on that step, not in a list at the bottom of the page.
  await expect(step(pageA, 1)).toContainText('GRIPPER_EMPTY');
  await expect(step(pageA, 1)).toContainText('with an empty gripper');
  await expect(step(pageA, 2)).not.toContainText('GRIPPER_EMPTY');

  await expect(runButton).toBeDisabled();
  await expect(pageA.getByRole('status')).toHaveText(
    'Fix the issues listed above before running this plan.',
  );

  // A broken plan still saves — the editor is where it gets fixed, and losing
  // half-corrected work on every reload would be worse than a bad row.
  await expect(saveButton).toBeEnabled();

  // --- fix it --------------------------------------------------------------
  await pageA.getByRole('button', { name: 'Move step 1 down' }).click();
  await pageA.getByRole('button', { name: 'Move step 2 down' }).click();

  await expectOps(pageA, ['MOVE_TO', 'PICK', 'MOVE_TO', 'PLACE']);
  await expect(pageA.getByText('GRIPPER_EMPTY')).toHaveCount(0);
  await expect(pageA.getByText('No blocking issues. This plan is ready to run.')).toBeVisible();

  // Still blocked, but now for the honest reason: runs simulate the saved plan.
  await expect(runButton).toBeDisabled();
  await expect(pageA.getByRole('status')).toHaveText(
    'Save your changes first — runs simulate the saved plan.',
  );

  // --- and Run comes back --------------------------------------------------
  await saveButton.click();

  await expect(pageA.getByText('Saved.')).toBeVisible();
  await expect(pageA.getByRole('status')).toHaveCount(0);
  await expect(runButton).toBeEnabled();
});

/**
 * One step row, found by the operation dropdown it contains.
 *
 * Addressed through its own labelled control rather than by position in the
 * list: the rows renumber on every move, and a positional locator would drift
 * one row off in exactly the assertions this spec exists to make.
 */
function step(page: Page, index: number): Locator {
  return page.getByRole('listitem').filter({ has: page.getByLabel(`Step ${index} operation`) });
}

/**
 * Asserts the plan's operations, in order.
 *
 * Read off each row's dropdown value rather than its text. A `select`
 * contributes *every* option to its element's text content, so
 * `toContainText('PLACE')` is true of every step row on the page — an assertion
 * that passes whatever the plan says, which is worse than none at all.
 */
async function expectOps(page: Page, ops: string[]): Promise<void> {
  for (const [index, op] of ops.entries()) {
    await expect(page.getByLabel(`Step ${index} operation`)).toHaveValue(op);
  }
}
