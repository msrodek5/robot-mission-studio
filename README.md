# Robot Mission Studio

Describe a warehouse robot's job in plain language, get a structured mission
plan, watch it run on a deterministic grid simulation, and — when it fails —
get an explanation of why and what to change.

**Live URL:** _pending — see [Deploy](#deploy)_

Capstone project for 10xDevs 3.0. Product definition in
[`.ai/prd.md`](./.ai/prd.md), stack rationale in
[`.ai/tech-stack.md`](./.ai/tech-stack.md), build order in
[`.ai/implementation-plan.md`](./.ai/implementation-plan.md).

## The determinism story

`simulate(layout, mission, opts)` is a pure function in `src/lib/sim` with zero
dependencies and no I/O — no clock, no `Math.random()`, no network. Randomness,
when it arrives, comes only from a seeded RNG passed in `SimOptions`.

That single constraint pays for itself three times over:

1. **One implementation, two runtimes.** The same function runs in the browser
   for instant preview and on the server for persisted runs. No drift, no
   round-trip per frame.
2. **Animation frames are never stored.** `layout + mission + seed` fully
   determines a run, so playback recomputes frames from the persisted log
   instead of the database holding thousands of rows of tweens.
3. **Tests need no mocking at all.** Golden fixtures in `tests/fixtures/` run
   through `simulate()` and snapshot the result, which is also what catches any
   accidental nondeterminism — A* ties are broken on `(f, h, x, y)` precisely so
   those snapshots stay stable.

## Stack

Astro (React islands) · TypeScript strict · Tailwind · Supabase (Postgres + RLS
+ Auth) · OpenRouter · Vitest + Playwright · Vercel.

## Getting started

```bash
npm install
cp .env.example .env    # fill in as milestones need them
npm run dev
```

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm test` | Vitest unit + golden tests |
| `npm run typecheck` | `astro check` |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright (M7) |

## Layout

```
src/pages          routes + server endpoints (/api/*)
src/components     React islands (editor, playback, plan list)
src/lib/sim        the simulation core — pure, zero deps
src/lib/ai         OpenRouter client, prompts, Zod schemas, repair loop
src/db             Supabase client, typed queries
supabase/migrations SQL migrations and RLS policies
tests/unit         Vitest
tests/e2e          Playwright
```

## Deploy

Vercel's Git integration builds a preview per pull request and production on
`main`. GitHub Actions ([`ci.yml`](./.github/workflows/ci.yml)) runs typecheck,
unit tests, and the build as the quality gate.

`GET /api/health` returns `{ status, commit }` and the landing page probes it on
load, so a broken deployment is visible without digging through logs.
