# Robot Mission Studio — Tech Stack

Each choice below records *why*, *what it costs*, and *what would change my mind*. A stack document that only lists winners is not evidence of a decision.

---

## Frontend — Astro 5 + React islands

**Why.** The app is mostly static shell with three genuinely interactive surfaces (layout editor, plan editor, run playback). Astro ships zero JS for the rest and lets those three be React islands. Server endpoints live in the same project, so there's no separate API deployment.

**Cost.** Island boundaries have to be thought about. State shared across islands needs an explicit store rather than a casual parent component. For an app this size that's a mild tax.

**What would change my mind.** If the editor and playback needed to share deep, continuously-updating state, a plain SPA would be simpler. They don't — playback consumes an immutable `RunResult`.

## Language — TypeScript, strict

**Why.** The domain is types: `Layout`, `Mission`, `Step`, `RunResult`. Strict mode plus discriminated unions on `Step` means the compiler enforces exhaustive handling of every operation in the simulator. Adding a new step type produces compile errors in exactly the places that need updating.

**Cost.** None that matters here.

## UI — Tailwind + shadcn/ui

**Why.** Component decisions are not where this project's value is. shadcn gives accessible primitives that are owned in-repo and editable rather than fought with.

**Cost.** Generated components add repo surface area. Acceptable.

## Database + Auth — Supabase (Postgres)

**Why.** Postgres with row-level security means authorisation is enforced at the data layer, not in application code that can forget. Auth, database, and migrations are one dependency instead of three. The migration files live in-repo and apply in CI.

**Cost.** RLS policies are easy to get *silently wrong* — a permissive policy looks identical to a correct one until someone else's data appears. This is mitigated by an explicit negative test, written before any UI depends on it.

**What would change my mind.** Multi-tenant org-level authorisation with relationship-based rules would outgrow RLS quickly. Single-user ownership does not.

## LLM — Anthropic API (direct)

*Revised 06.09.2026. Originally OpenRouter — see "Superseded" below.*

**Why.** The planner's job is structured extraction: given a station list and a sentence, emit a conforming `Mission`. Anthropic's API supports schema-constrained output via tool definitions, so the schema is enforced at generation time rather than only validated after the fact. That removes most of the "model returned JSON wrapped in markdown fences" failure class outright. The first-party SDK is also properly typed, which matters in a codebase where the whole point is that types carry the domain.

Mission planning does not need a frontier model — the model string stays pinned in `ANTHROPIC_MODEL` so the choice is a config change, and a small fast model is the default.

**Cost.** Single-provider coupling. Switching models is now a code change rather than an env change, and an Anthropic outage has no fallback path. Both are acceptable for a project with a three-week life and no availability requirement. Real production systems would want the indirection back.

**Design note — unchanged, and this is the important part.** Model output is never trusted, regardless of provider. Every response is parsed through a Zod schema, then passed through `validateMission()` for semantic checks, with a bounded repair loop (max 2 attempts) between. The LLM proposes; the validator disposes.

Schema-constrained output reduces *schema* failures. It does nothing for *semantic* ones — a plan that places an item before picking it up is perfectly well-typed and completely wrong. The semantic gate is what actually protects the product, and it survives any provider change.

### Superseded: OpenRouter

The original choice, for one-API access across providers and model swapping by environment variable. Dropped because the indirection was buying optionality this project will never exercise, at the cost of weaker typing and no access to schema-constrained generation. The tradeoff would invert for anything long-lived.

## Simulation core — plain TypeScript, zero dependencies

**Why.** `simulate(layout, mission, opts) → RunResult` is a pure function with no I/O. That single decision buys several things at once: it runs unchanged in the browser for instant preview and on the server for persisted runs; it is testable with no mocking whatsoever; and because the result is fully determined by its inputs, animation frames are recomputed rather than stored.

**Cost.** Purity has to be defended. A single `Date.now()` or `Math.random()` inside the core breaks reproducibility and every golden test. This is written into `CLAUDE.md` as a standing rule.

## Testing — Vitest + Playwright

**Why.** Vitest shares the Vite config the app already uses. Coverage is concentrated deliberately: the simulation core is tested hard (unit plus golden-file snapshots), the UI is tested thinly through a handful of E2E flows. Chasing global coverage percentages would be theatre.

**Cost.** Playwright is slow in CI and the LLM call has to be stubbed to keep E2E deterministic. One real integration test exists and is run manually.

## CI/CD — GitHub Actions → Vercel

**Why.** Astro's Vercel adapter is first-party. Preview deployments per PR. Migrations apply via the Supabase CLI as a pipeline step, so schema changes are code-reviewed like everything else.

**Cost.** Vendor coupling. For a capstone with a hard deadline, that is a feature.

---

## Rejected: Python + FastAPI backend

Worth recording, because it was the instinct.

Python with FastAPI, gRPC contracts, and a service split is closer to my daily work and would produce a more conventionally "correct" backend architecture. It was rejected for three reasons:

1. **The simulation core would have to exist twice** — once in Python for the server, once in TypeScript for browser preview — or preview would need a network round-trip per frame. Duplicated logic is a guaranteed source of drift.
2. **The course's tooling and conventions are tuned to the TS stack.** A capstone with a three-week runway is not the place to spend velocity proving stack independence.
3. **Two deployment targets instead of one**, for an app that needs neither the throughput nor the isolation.

The tradeoff is real: the result is less architecturally interesting than a proper service split, and a reviewer could fairly call it a monolith. It ships, which for this project matters more.
