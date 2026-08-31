/**
 * Setup shortcuts, and the one way this suite talks to the API.
 *
 * Drawing a layout through the editor is the happy path's own subject, so that
 * spec does it by hand. Every other spec needs a layout to exist and does not
 * care how it got there; doing it through the UI three more times would add
 * thirty seconds of wall clock and three more things that can flake for reasons
 * unrelated to what is being asserted. The seeding here goes through the same
 * `/api/layouts` endpoints the editor calls, as the same signed-in user, so RLS
 * and the real schema are still in the loop — nothing is written behind the
 * app's back with a service-role key.
 *
 * ## Why `callApi` and not `page.request`
 *
 * Playwright's `page.request` has its own notion of a request initiator and does
 * not send this app's `SameSite=Lax` session cookie, so every call came back
 * `401 Not signed in.` while the very same page navigated fine. Rather than
 * loosen a cookie attribute for a test's benefit, the calls go through the
 * page's own `fetch` — which is exactly how the React islands call these
 * endpoints in production, cookies, origin checks and all.
 */

import { expect, type Page } from '@playwright/test';

export type Cell = { x: number; y: number };

export type StationSeed = {
  id: string;
  name: string;
  kind: 'dock' | 'shelf' | 'charger';
  cell: Cell;
  items?: string[];
};

export type LayoutSeed = {
  width: number;
  height: number;
  obstacles: Cell[];
  stations: StationSeed[];
  start: Cell;
};

export type ApiResponse = { status: number; body: string };

/** Fixed uuids, so a failure message names a station you can recognise. */
export const STATION_IDS = {
  shelf: '11111111-1111-4111-8111-111111111111',
  dock: '22222222-2222-4222-8222-222222222222',
  charger: '33333333-3333-4333-8333-333333333333',
} as const;

export const DEMO_ITEM = 'demo-crate';

/**
 * A 10x10 grid with a stocked shelf, a dock, and a short wall between them.
 *
 * Stocked because `PICK` fails with `ITEM_NOT_PRESENT` against an empty shelf
 * and the editor has no way to put an item on one — the same reason the run
 * launcher grew its "stock a shelf" button. The obstacles are there so A* has
 * something to route around and playback has more than a straight line to show.
 */
export function stockedLayout(): LayoutSeed {
  return {
    width: 10,
    height: 10,
    obstacles: [
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 4, y: 5 },
    ],
    stations: [
      {
        id: STATION_IDS.shelf,
        name: 'Shelf A',
        kind: 'shelf',
        cell: { x: 7, y: 4 },
        items: [DEMO_ITEM],
      },
      { id: STATION_IDS.dock, name: 'Dock', kind: 'dock', cell: { x: 1, y: 8 } },
    ],
    start: { x: 0, y: 0 },
  };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * Waits for every React island on the page to finish hydrating.
 *
 * Astro server-renders islands and hydrates them in the browser a moment later.
 * In between, the markup is complete and looks interactive but is dead: `fill`
 * writes into an input whose React `onChange` does not exist yet, hydration then
 * replaces the tree, and the typed value is gone. The only symptom is a submit
 * button that never enables — a genuine race, not a test artefact, and the
 * reason every navigation is followed by this call.
 *
 * `<astro-island>` carries an `ssr` attribute until its component has mounted
 * and drops it afterwards. That is the one hydration signal the page offers, so
 * it is the one this waits on.
 */
export async function waitForIslands(page: Page): Promise<void> {
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);

  /**
   * `ssr` comes off a tick too early.
   *
   * Astro's React renderer hands `hydrateRoot` to `startTransition`, which
   * returns before React has attached anything, and `<astro-island>` drops its
   * attribute as soon as that call returns. A click in the gap is swallowed in
   * silence — the symptom is an obstacle that never appears, intermittently.
   *
   * React tags its root container with an own `__reactContainer$…` property when
   * it does attach, and from outside the page that is the only evidence
   * available. Internal, and knowingly so: the alternative is a sleep.
   */
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('astro-island')).every((island) =>
        Object.keys(island).some((key) => key.startsWith('__react')),
      ),
    undefined,
    { timeout: 10_000 },
  );
}

/** `goto` plus the hydration wait, which is what every spec actually wants. */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForIslands(page);
}

/** `reload` plus the hydration wait. */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await waitForIslands(page);
}

// ---------------------------------------------------------------------------
// The API, over the page's own session
// ---------------------------------------------------------------------------

/**
 * Calls an endpoint with the page's own `fetch`.
 *
 * The page has to be on this origin for the session cookie to ride along, so a
 * blank one is parked on `/api/health` first — the cheapest same-origin document
 * in the app and the only route that needs no session.
 */
export async function callApi(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  if (!page.url().startsWith('http')) await page.goto('/api/health');

  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      return { status: response.status, body: await response.text() };
    },
    { method, path, body },
  );
}

/** Creates a layout and saves the given grid onto it. Returns its id. */
export async function seedLayout(page: Page, name: string, layout: LayoutSeed): Promise<string> {
  const created = await callApi(page, 'POST', '/api/layouts', { name });
  expect(created.status, created.body).toBe(201);

  const { layout: record } = JSON.parse(created.body) as { layout: { id: string } };

  const saved = await callApi(page, 'PUT', `/api/layouts/${record.id}`, { name, layout });
  expect(saved.status, saved.body).toBe(200);

  return record.id;
}

/**
 * Creates the demo mission for a layout and runs it. Returns both ids.
 *
 * The success demo is the deterministic four-step pick-and-place — MOVE_TO,
 * PICK, MOVE_TO, PLACE — which is the plan the editor spec needs to break.
 */
export async function runDemoMission(
  page: Page,
  layoutId: string,
  kind: 'success' | 'failing',
): Promise<{ runId: string; missionId: string }> {
  const created = await callApi(page, 'POST', '/api/runs/demo', { layoutId, kind });
  expect(created.status, created.body).toBe(201);

  const { run, mission } = JSON.parse(created.body) as {
    run: { id: string };
    mission: { id: string };
  };

  return { runId: run.id, missionId: mission.id };
}
