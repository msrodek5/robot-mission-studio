# Robot Mission Studio — Implementation Plan

**Capstone project, 10xDevs 3.0**
Status: v1 · Owner: Mariusz · Ship 15.09.2026, deadline 16.09.2026

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

| M | Session | Deliverable | Done when |
|---|---|---|---|
| **M0** | 1 | Repo, Astro, Supabase project, Vercel deploy, GH Actions skeleton | **Live URL loads.** Non-negotiable, do it first |
| **M1** | 2–3 | `src/lib/sim` + tests, no UI at all | `npm test` green, 15+ tests, fixtures run |
| **M2** | 4 | Schema, migrations, RLS, Supabase Auth | Login works on the prod URL; negative RLS test passes |
| **M3** | 5–6 | Layout editor (canvas grid, obstacles, stations), persistence | Draw → save → reload → identical |
| **M4** | 7 | Run a hardcoded mission from the UI + playback with scrubber | Robot animates on the deployed URL |
| **M5** | 8–9 | LLM planner, Zod validation, repair loop, plan editor + linter | Type a brief → get a plan → run it |
| **M6** | 10 | Postmortem on failure, cached | Failed run shows diagnosis + suggested fixes |
| **M7** | 11–12 | Playwright suite, CI green end to end, README + `.ai/` docs | Green pipeline, docs complete |
| **M8** | 13–14 | Polish, empty states, demo recording, buffer | Submission-ready |

Sessions 13–14 are buffer, not features. They will be consumed. That is fine and expected.

### Calendar — deadline 16.09.2026

**Ship date is 15.09, not 16.09.** The deadline is not the plan.

| Dates | Milestones | Notes |
|---|---|---|
| Mon 24 – Sun 30 Aug | M0, M1, M2 | M0 **tonight**. Sat 29 is the long block: schema + RLS + auth |
| Mon 31 Aug – Sun 6 Sep | M3, M4 | Layout editor eats the weeknights; Sat 5 for playback |
| Mon 7 – Sun 13 Sep | M5, M6, M7 | Planner, postmortem, then Sat 12 for Playwright + CI |
| Mon 14 – Tue 15 Sep | M8 | Polish, demo recording, **submit Tue** |
| Wed 16 Sep | — | Deadline. Code is frozen. Do not open the editor |

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

- [ ] `.ai/prd.md` — problem, users, stories US-1..US-7, out-of-scope
- [ ] `.ai/tech-stack.md` — with the *why* for each choice
- [ ] `.ai/implementation-plan.md` — this document
- [ ] `CLAUDE.md` / rules-for-AI — conventions, sim-core purity rule, no-any rule
- [ ] Auth implemented (Supabase)
- [ ] CRUD on a user-owned entity (layouts, missions)
- [ ] LLM feature (two of them)
- [ ] Vitest unit tests
- [ ] Playwright E2E tests
- [ ] GitHub Actions CI/CD
- [ ] Deployed, publicly reachable URL
- [ ] README with the determinism story and a screenshot/GIF

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
