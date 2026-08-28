# CLAUDE.md — Robot Mission Studio

Standing rules for every session in this repo. Read `.ai/implementation-plan.md` for what to build; this file is how to build it.

## Context

Capstone project, hard deadline 16.09.2026, ship target 15.09. Scope discipline beats elegance. When in doubt, choose the version that ships.

## Non-negotiable rules

1. **`src/lib/sim` is pure.** No imports outside the module. No `Date.now()`, no `Math.random()`, no `fetch`, no logging, no environment access. Randomness comes only from the seeded RNG passed in `SimOptions`. Violating this breaks reproducibility and every golden test.
2. **No `any`.** No `@ts-ignore`. No non-null assertions (`!`) except in tests. If types fight you, the model is wrong — fix the model.
3. **Zod schemas are the source of truth for types.** Derive TS types with `z.infer`. Never hand-write a type that duplicates a schema.
4. **LLM output is untrusted input.** Every response parses through Zod, then through `validateMission()`. Never construct a `Mission` from raw model text.
5. **Every DB table has RLS enabled with an ownership policy.** New table means new policy in the same migration, no exceptions.
6. **`frames` are never persisted.** Runs store the log; playback recomputes from `layout + mission + seed`.

## Working style

- **One milestone per session.** Do not start the next milestone because the current one finished early. Stop and report.
- **Do not touch files outside the milestone's stated scope.** If a change elsewhere seems necessary, say so and wait.
- Write tests in the same session as the code they test, not "later".
- Prefer deleting code to commenting it out.
- No new dependencies without asking. The sim core takes none, ever.

## Conventions

- Files: `kebab-case.ts`. React components: `PascalCase.tsx`.
- Discriminated unions over boolean flags. `Step` is discriminated on `op`.
- Errors: return typed results from the sim core (`RunResult.failure`); throw only for programmer error.
- Tests colocated by concern: `tests/unit/sim/*.test.ts`, golden fixtures in `tests/fixtures/`.
- Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) are never imported into anything that ships to the browser.

## Commands

```bash
npm run dev          # local dev server
npm test             # vitest, must be green before any commit
npm run test:e2e     # playwright, LLM stubbed
npm run typecheck    # tsc --noEmit
npx supabase db push # apply migrations
```

## When scope is ambiguous

Check `.ai/prd.md` section 5 (non-goals) first. If the thing is listed there, the answer is no. If it isn't listed and it isn't in the current milestone, ask rather than assume — the deadline is real and the plan has tripwires for exactly this.
