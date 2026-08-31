# Robot Mission Studio — Implementation Plan

**Capstone project, 10xDevs 3.0**
Status: v1 · Owner: Mariusz · **M0–M7 complete 31.08.2026** · Ship 13.09.2026, deadline 14.09.2026

> **Update — 31.08.2026.** M0 through M7 are done and the pipeline is green.
> The deadline moved forward to 14.09 and **M8 was cut**. Section 13 records
> that and every other place where the build diverged from this plan, including
> the ones that were mistakes. The deviations are not tidied up to look like they
> were intended — that would defeat the purpose of writing them down.

---

## 0. The one rule

**A deployed URL exists before any interesting code is written.** Milestone M0 is a live "hello" page on Vercel with auth stubbed out. Everything after that is incremental improvement to something that already ships. If the schedule slips, you slip features, never the deploy.

This is the whole risk of this project. Not A*, not the LLM, not RLS.

---

## 1. Product definition

Lives in [`.ai/prd.md`](./prd.md) — problem, personas, user stories US-1..US-7 with acceptance criteria, failure classes, and the binding non-goals list.

Stack rationale lives in [`.ai/tech-stack.md`](./tech-stack.md).
Standing agent rules live in [`CLAUDE.md`](../CLAUDE.md) at the repo root.

## 2. Architecture

```
apps/web            Astro 5 + React islands, Tailwind, shadcn/ui
  src/pages         routes + server endpoints (/api/*)
  src/components    React islands (editor, playback, plan list)
  src/lib/sim       ← the simulation core, pure TypeScript, zero deps
  src/lib/ai        Anthropic client, prompts, Zod schemas, repair loop
  src/db            Supabase client, typed queries
supabase/migrations SQL migrations, RLS policies
tests/unit          Vitest
tests/e2e           Playwright
.ai/                prd.md, tech-stack.md, implementation-plan.md
```

**Why the sim core is a separate pure module:** the same `simulate()` runs in the browser for instant preview and on the server for persisted runs. One implementation, no drift, and Vitest tests it headless with zero mocking.

---

## 3. Simulation core (the heart — build this second)

```ts
type Cell = { x: number; y: number };

type Station = {
  id: string;
  name: string;
  cell: Cell;
  kind: 'dock' | 'shelf' | 'charger';
};

type Layout = {
  width: number;          // 5..30
  height: number;         // 5..30
  obstacles: Cell[];
  stations: Station[];
  start: Cell;
};

type Step =
  | { op: 'MOVE_TO'; stationId: string }
  | { op: 'PICK';    stationId: string; item: string }
  | { op: 'PLACE';   stationId: string; item: string }
  | { op: 'WAIT';    ticks: number }
  | { op: 'CHARGE';  stationId: string; toPercent: number };

type Mission = { steps: Step[] };

type FailureCode =
  | 'UNKNOWN_STATION'
  | 'UNREACHABLE'
  | 'GRIPPER_FULL'
  | 'GRIPPER_EMPTY'
  | 'ITEM_NOT_PRESENT'
  | 'WRONG_STATION_KIND'
  | 'BATTERY_DEPLETED';

type RunResult = {
  status: 'success' | 'failed';
  failure?: { stepIndex: number; code: FailureCode; detail: string };
  ticks: number;
  distance: number;
  batteryEnd: number;
  frames: Frame[];        // playback only — never persisted
  log: LogEntry[];        // persisted, feeds the postmortem
};

function simulate(layout: Layout, mission: Mission, opts: SimOptions): RunResult;
```

### Rules (v1, deliberately boring)

- 4-neighbour grid, A* with Manhattan heuristic.
- **Deterministic tie-break:** sort the open set by `(f, h, x, y)`. Without this your golden tests flake and you'll lose an evening finding out why.
- Costs: 1 tick + 0.5% battery per cell moved; PICK/PLACE = 2 ticks + 1%; CHARGE = 1 tick per 5%.
- Battery starts at 100%. Hitting 0 mid-step → `BATTERY_DEPLETED`.
- `seed` is in `SimOptions` from day one but unused in v1. It reserves the slot for stochastic events (station busy, wheel slip) without a later signature change that breaks every test.
- **Frames are recomputed, never stored.** `layout + mission + seed` fully determines the run. That's the payoff of determinism, and it's worth one sentence in your README.

### Separate pure validator

```ts
function validateMission(layout: Layout, mission: Mission): Issue[];
```

Catches unknown station IDs, PLACE without a prior PICK, CHARGE at a non-charger, empty plans. Used in three places: to gate LLM output, as the live linter in the plan editor, and as a fat block of easy unit tests.

---

## 4. AI features

### 4.1 Planner — natural language → `Mission`

- **Input:** layout summary (dimensions, station list with ids/names/kinds) + user brief.
- **Output:** JSON only, no prose, matching a Zod schema mirroring `Mission`.
- **Repair loop:** parse → on Zod failure, resend once with the error text appended, max 2 attempts, then surface a clean error to the user.
- **Semantic gate:** run `validateMission()` on the parsed result. Schema-valid but nonsensical plans (place before pick) go back through the repair loop with the issue list.
- **Persist** `model`, `prompt_version`, and token usage on the mission row. Cheap to add, and it's the kind of detail that reads as senior in a review.
- Pin the model string in env (`ANTHROPIC_MODEL`), use a small fast model — planning a 6-step mission is not a frontier-model task.

### 4.2 Postmortem — failed run → explanation

- **Input:** layout summary + mission + failure object + last ~20 log entries.
- **Output:** `{ diagnosis: string; suggestedEdits: { stepIndex: number; change: string }[] }`.
- **Cache it on the run row.** Re-opening a run must not re-bill you.

This second feature is what separates the project from the flashcard clones. It's LLM used where an algorithm would be awkward — turning a state trace into a human explanation.

---

## 5. Data model

```sql
layouts (id, user_id, name, width, height, grid jsonb, created_at, updated_at)
missions (id, user_id, layout_id, name, brief text, plan jsonb,
          source text check (source in ('ai','manual')),
          model text, prompt_version text, created_at)
runs     (id, user_id, mission_id, seed int, status text,
          ticks int, distance numeric, battery_end numeric,
          failure jsonb, log jsonb, postmortem jsonb, created_at)
```

RLS on every table: `using (user_id = auth.uid())` for select/update/delete, `with check (user_id = auth.uid())` for insert. **Write a negative test for this** — a silently permissive RLS policy is the single most common bug in Supabase capstones and it looks fine in the UI.

---

## 6. API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/layouts` | list, create |
| GET/PUT/DELETE | `/api/layouts/:id` | |
| POST | `/api/missions/generate` | brief + layoutId → plan (LLM) |
| GET/POST/PUT | `/api/missions[/:id]` | |
| POST | `/api/runs` | missionId → simulate server-side, persist |
| POST | `/api/runs/:id/postmortem` | idempotent, cached |
| GET | `/api/runs?missionId=` | history |

Types generated from Zod schemas, shared between client and server. Service-role key server-side only.

---

## 7. Test strategy

**Vitest (unit)** — target the sim core hard, ignore coverage elsewhere:
- A*: reachable, unreachable, walled-in start, deterministic path on ties
- Battery: depletion mid-move, charge to target, charger-kind check
- One test per `FailureCode`
- `validateMission` rules
- Zod parse + repair loop against fixture LLM responses (mocked fetch)

**Golden tests** — `tests/fixtures/*.json` → `simulate()` → snapshot `RunResult` minus `frames`. Cheap, high signal, and they'd catch any accidental nondeterminism.

**Playwright (E2E)** — four flows, LLM stubbed via `page.route()`:
1. Sign up → create layout → generate mission → run → success banner
2. Failure path → postmortem card renders
3. Auth guard: user B cannot open user A's layout URL
4. Plan editor: manual edit → lint issue appears → fix → run

---

## 8. CI/CD

GitHub Actions:
- **PR:** lint → typecheck → vitest → build → playwright against the built preview
- **main:** the above, then deploy to Vercel
- Supabase migrations committed in-repo, applied via CLI step

Secrets: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## 9. Milestones

Sized for evening sessions (~2–3h each). Every milestone ends deployed.

| M | Session | Deliverable | Done when | Status |
|---|---|---|---|---|
| **M0** | 1 | Repo, Astro, Supabase project, Vercel deploy, GH Actions skeleton | **Live URL loads.** Non-negotiable, do it first | ✅ 24.08.2026 |
| **M1** | 2–3 | `src/lib/sim` + tests, no UI at all | `npm test` green, 15+ tests, fixtures run | ✅ 25.08.2026 |
| **M2** | 4 | Schema, migrations, RLS, Supabase Auth | Login works on the prod URL; negative RLS test passes | ✅ 26.08.2026 |
| **M3** | 5–6 | Layout editor (canvas grid, obstacles, stations), persistence | Draw → save → reload → identical | ✅ 27.08.2026 |
| **M4** | 7 | Run a hardcoded mission from the UI + playback with scrubber | Robot animates on the deployed URL | ✅ 27.08.2026 |
| **M5** | 8–9 | LLM planner, Zod validation, repair loop, plan editor + linter | Type a brief → get a plan → run it | ✅ 28.08.2026 |
| **M6** | 10 | Postmortem on failure, cached | Failed run shows diagnosis + suggested fixes | ✅ 31.08.2026 |
| **M7** | 11–12 | Playwright suite, CI green end to end, README + `.ai/` docs | Green pipeline, docs complete | ✅ 31.08.2026 |
| **M8** | 13–14 | Polish, empty states, demo recording, buffer | Submission-ready | ❌ **Cut** — see 13.3 |

Sessions 13–14 were planned as buffer, not features, on the assumption they would
be consumed. They were not needed: M0–M7 landed in eight days rather than the
twelve sessions budgeted. When the deadline then moved forward to 14.09, M8 was
cut rather than compressed.

### Calendar — deadline 16.09.2026

**Ship date is 15.09, not 16.09.** The deadline is not the plan.

| Dates | Milestones | Notes | Actual |
|---|---|---|---|
| Mon 24 – Sun 30 Aug | M0, M1, M2 | M0 **tonight**. Sat 29 is the long block: schema + RLS + auth | M0–M5 all landed in this window |
| Mon 31 Aug – Sun 6 Sep | M3, M4 | Layout editor eats the weeknights; Sat 5 for playback | Done 27.08, four days early |
| Mon 7 – Sun 13 Sep | M5, M6, M7 | Planner, postmortem, then Sat 12 for Playwright + CI | Done 28–31.08, ~11 days early |
| Mon 14 – Tue 15 Sep | M8 | Polish, demo recording, **submit Tue** | **Cut.** Deadline moved to 14.09 |
| Wed 16 Sep | — | Deadline. Code is frozen. Do not open the editor | Deadline is now Mon 14.09 |

The schedule was pessimistic by roughly two weeks, which is the pleasant
direction to be wrong in and not one worth congratulating: the estimate was for
2–3h evening sessions and the sessions turned out to be longer and denser than
that. **Feature freeze came into force on 31.08**, when M6 shipped, rather than on
13.09 — M7 was built entirely under freeze, which is why section 13 has an entry
about ESLint.

**Feature freeze: Saturday 13 September.** After that date, only tests, docs, copy, and bug fixes. No new features regardless of how small they look.

Note that 10xDevs 4.0 starts 14 September — new cohort material will land squarely in your final polish window. Ignore it until you've submitted.

### Tripwires

Each of these is a pre-committed decision, not a judgement call to make while tired:

| If, by… | …this isn't true | Then cut |
|---|---|---|
| Wed 26 Aug | Live URL exists | Nothing — stop and fix this first, the project is at risk |
| Sun 30 Aug | Sim core tests green | Layout editor → fixed 10×10 grid, JSON textarea for stations |
| Wed 10 Sep | Planner returns valid plans | Plan editor and linter (US-4) — ship generate-only |
| Sat 13 Sep | E2E suite green | Drop to 2 Playwright flows: happy path + auth guard |

**No tripwire fired.** The live URL existed on 24.08, the sim core was green on
25.08, the planner returned valid plans on 28.08, and all four Playwright flows
pass — so the plan editor and linter (US-4) shipped, and the E2E suite was not
cut down to two flows. Recorded because a tripwire that never fires is still
worth having: each one was a decision made while rested, and not needing them is
the outcome they were designed for.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Sim scope creep (physics, arms, 3D) | Grid + A* only. Out-of-scope list is binding |
| Canvas rendering rabbit hole | Plain 2D canvas, ~24px cells. CSS-grid divs are an acceptable v1 fallback |
| LLM nondeterminism breaks E2E | Stub the route in Playwright; one real integration test, run manually |
| Silently permissive RLS | Explicit negative test in M2, before any UI depends on it |
| Design doc grows, code doesn't | M0 first. If it's session 4 and there's no live URL, cut features immediately |

---

## 11. Course artifact checklist

- [x] `.ai/prd.md` — problem, users, stories US-1..US-7, out-of-scope
- [x] `.ai/tech-stack.md` — with the *why* for each choice
- [x] `.ai/robot-mission-studio-implementation-plan.md` — this document
- [x] `CLAUDE.md` / rules-for-AI — conventions, sim-core purity rule, no-any rule
- [x] Auth implemented (Supabase)
- [x] CRUD on a user-owned entity (layouts, missions)
- [x] LLM feature (two of them: planner + postmortem)
- [x] Vitest unit tests — 308 passing, sim core at 95% lines
- [x] Playwright E2E tests — four flows, LLM stubbed, run against the built app
- [x] GitHub Actions CI/CD — typecheck → lint → vitest+coverage → build → Playwright
- [x] Deployed, publicly reachable URL — <https://robot-mission-studio.vercel.app>
- [x] README with the determinism story
- [ ] Screenshot/GIF in the README — **still a `TODO` marker.** The only
      outstanding item, and it needs a human with a screen recorder

---

## 12. First action

Not "design the schema." This:

```bash
npm create astro@latest robot-mission-studio -- --template minimal --typescript strict
cd robot-mission-studio
npx astro add react tailwind vercel
git init && git add -A && git commit -m "chore: bootstrap"
gh repo create robot-mission-studio --private --source=. --push
npx vercel --prod
```

Ten minutes. Then the URL exists and the project is real.

---

## 13. What actually happened

Written after the fact, on 31.08.2026. Every entry is a place where the built
thing differs from this plan. Some were good calls, some were forced, and two
were plain errors in the plan — they are labelled as such rather than reframed.

### 13.1 CSS grid instead of canvas for playback

**Planned** (section 10): "Plain 2D canvas, ~24px cells. CSS-grid divs are an
acceptable v1 fallback."

**Built:** the fallback, and it should have been the first choice. `GridView`
renders one element per cell in a CSS grid — 400 nodes at 20×20, which the
browser handles without complaint. What that bought, for free and twice over
(the editor and the player share the renderer): focus, keyboard access, hit
testing, and a screen-reader label per cell. A canvas would have meant
reimplementing all four, and the E2E suite would have had no way to assert "cell
4,3 is an obstacle" other than pixel comparison. Instead it reads the same
accessible name a screen reader does.

The canvas rabbit hole named in the risk table was avoided by not entering it.

### 13.2 Anthropic instead of OpenRouter

**Planned** (sections 4.1, 8): OpenRouter, with `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL`.

**Built:** the Anthropic SDK directly, with `ANTHROPIC_API_KEY` and
`ANTHROPIC_MODEL`, defaulting to `claude-haiku-4-5`. The deciding factor was tool
use: both features depend on forced structured output (`emit_mission`,
`emit_postmortem`) with a JSON Schema derived from the Zod schema, and going
through the provider's own SDK meant the typed `APIError` subclasses were
available for mapping transport failures onto the four `PlannerErrorCode`s.
OpenRouter's value is model shopping, which this project does not do — the model
is pinned in env and the whole point of the schema is that a small model cannot
go far wrong inside it.

Cost of the switch: one env variable rename, and `.env.example` carried the stale
OpenRouter names until M7.

### 13.3 M8 cut when the deadline moved to 14.09

**Planned:** sessions 13–14 (Mon 14 – Tue 15 Sep) for polish, empty states, and
a demo recording, submitting Tue 15.09 against a 16.09 deadline.

**Cut.** The deadline moved forward to 14.09, which deleted the submission window
M8 lived in. This was the cheapest thing to lose because M0–M7 had already
landed eleven days early and section 0's one rule held throughout — the URL has
been live since 24.08, so there is no "get it deployed" work hiding inside the
polish milestone. What went with M8: empty-state copy passes, and the demo
recording. The screenshot `TODO` in the README is the visible scar.

### 13.4 The E2E suite runs against the production build, via a hand-rolled server

**Planned** (section 7): "Playwright against the built preview."

**Built:** that, but it took more work than the phrase implies.
`astro preview` does not work with `@astrojs/vercel` — the adapter declares no
preview entrypoint, because in production the function is booted by Vercel's own
runtime. The options were to test `astro dev` (and never exercise the artefact
that ships) or to boot the built function directly.
`tests/e2e/support/serve-build.mjs` does the latter in about sixty lines:
`.vercel/output/_functions/entry.mjs` exports a plain `{ fetch(request) }`, so a
`node:http` bridge plus the two filesystem rules from `config.json` is enough.

Worth it, and worth knowing it is load-bearing: it is the reason CI tests the
production bundle rather than a dev server.

### 13.5 The model is stubbed at `ANTHROPIC_BASE_URL`, not with `page.route`

**Planned** (sections 7, 10): "Stub the route in Playwright."

**Built:** a stub Anthropic server. `page.route` cannot intercept either AI
feature, because both construct the SDK client inside a server request handler
where no browser is involved. Stubbing our own `/api/missions/generate` instead
would have been worse than useless: the endpoint *persists* the mission, so a
faked response returns an id that names no row and the very next navigation
404s — and the postmortem cache test would have had nothing cached to reload.

So the seam is `ANTHROPIC_BASE_URL`, which the SDK reads, pointed at
`tests/e2e/support/anthropic-stub.mjs`. Everything downstream of the model runs
for real: the Zod gate, the repair loop, `validateMission`, the insert, the
RLS-scoped read back. A `page.route` tripwire remains, and fails any test in
which the *browser* reaches for `api.anthropic.com`.

### 13.6 `npm run lint` is a repo-rules script, not ESLint

**Planned** (section 8): "lint → typecheck → vitest → build → playwright."

**Built:** `scripts/lint-rules.mjs`, which enforces the four `CLAUDE.md` standing
rules — no `any`, no `@ts-ignore`, no non-null assertions outside tests, and no
import escaping `src/lib/sim`, plus the sim core's clock/randomness/network/env
bans. No linter had ever been configured, and M7 ran under feature freeze;
introducing ESLint, `typescript-eslint` and two plugins on the last weekend meant
a dozen packages and a rules argument, with the near-certainty of surfacing
pre-existing findings across working code.

This is a real gap, stated plainly: there is no formatting or style enforcement
in this repo. `astro check` does the type checking, and the script covers the
rules that would actually cause damage. It has a negative control — it was run
against a deliberately bad file and caught all seven violations.

### 13.7 CI runs Node 24, not Node 20

Astro 7 declares `engines.node >= 22.12.0`, so `npm ci` cannot even install this
project on Node 20. CI uses `node-version-file: .nvmrc` (24), which also matches
the `nodejs24.x` runtime the Vercel adapter emits. One version string, three
places in agreement.

### 13.8 Two dependencies added during freeze, both asked for first

`@playwright/test` (the milestone's subject) and `@vitest/coverage-v8`, without
which `vitest run --coverage` cannot run non-interactively and the CI job summary
has no sim-core coverage figure to report. `src/lib/sim` still has zero
dependencies, as it always will.

### 13.9 One production file was touched during freeze

`src/components/playback/RunPlayback.tsx` gained `data-step-index` and
`data-failing` attributes on the playback step list. The failing step was
distinguished by colour alone, which no test — and no screen reader — can read.
Two inert attributes, no behaviour change, and the alternative was asserting on a
Tailwind class name. Flagged here because "no changes outside the milestone" was
the rule and this is the exception.

### 13.10 The section 2 architecture sketch was never accurate

Left in place above rather than quietly corrected, because it is a useful record
of what was guessed wrong at the start. Three things in it are false:
`apps/web` — this is a single package, not a monorepo, and the extra directory
level would have bought nothing; `Astro 5` — the project was built on Astro 7,
which is what `npm create astro` produced on 24.08; and `shadcn/ui`, which was
never installed. Tailwind utility classes turned out to be enough for a grid, a
station table, and four buttons, and a component library would have been a
dependency carrying a design system this app has no use for.

### 13.11 Things that were planned and held

Recorded because a deviations list that only lists misses reads as though nothing
worked:

- **`src/lib/sim` never grew a dependency**, a clock, or a random call. The lint
  script now enforces that mechanically rather than by memory.
- **`frames` are never persisted.** More than that: the player recomputes them
  and *compares* its own status and tick count against the persisted row,
  refusing to animate if they disagree.
- **The deterministic A* tie-break on `(f, h, x, y)`** was in from M1, and the
  golden fixtures have never flaked.
- **`seed` has been in `SimOptions` since day one**, unused. Adding stochastic
  events will not change a single test signature.
- **RLS answers 404, never 403**, on every route that takes an id — proven from
  both directions, by `tests/rls/negative-rls.test.ts` at the policy level and by
  `auth-guard.spec.ts` through the app.
- **Section 0's one rule held.** The URL was live on day one and has never gone
  down. Every milestone ended deployed.
