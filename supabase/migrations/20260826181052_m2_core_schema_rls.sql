-- M2 — core schema, row-level security, and Data API grants.
--
-- Three owned tables: layouts, missions, runs. Shape follows
-- `.ai/implementation-plan.md` section 5.
--
-- Every table gets `enable row level security` plus four policies keyed on
-- `user_id = auth.uid()` (CLAUDE.md rule 5). A table without its policy in the
-- same migration is the bug this milestone exists to prevent, so they are never
-- split across files.

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------

-- `search_path = ''` forces every reference inside the body to be
-- schema-qualified, so the function cannot be hijacked by a caller-controlled
-- search_path.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- layouts
-- ---------------------------------------------------------------------------

create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Mirrors the 5..30 bounds documented on `Layout` in src/lib/sim/types.ts.
  width integer not null check (width between 5 and 30),
  height integer not null check (height between 5 and 30),
  -- Obstacles, stations, and start cell. The sim core owns the shape; Postgres
  -- only guarantees it is an object.
  grid jsonb not null default '{}'::jsonb check (jsonb_typeof(grid) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.layouts is
  'User-owned warehouse grids. grid holds obstacles, stations, and start cell.';

create index layouts_user_id_created_at_idx
  on public.layouts (user_id, created_at desc);

create trigger layouts_set_updated_at
  before update on public.layouts
  for each row execute function public.set_updated_at();

alter table public.layouts enable row level security;

create policy layouts_select_own on public.layouts
  for select to authenticated
  using (user_id = auth.uid());

create policy layouts_insert_own on public.layouts
  for insert to authenticated
  with check (user_id = auth.uid());

create policy layouts_update_own on public.layouts
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy layouts_delete_own on public.layouts
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- missions
-- ---------------------------------------------------------------------------

-- Known gap, deliberate in M2: the policies below key only on `user_id`, so a
-- user may insert their own mission whose `layout_id` points at another user's
-- layout. Nothing leaks — the referenced layout stays unreadable — but the
-- dangling cross-owner reference is accepted. Closing it needs an
-- `exists (select 1 from public.layouts ...)` clause in the `with check`.
create table public.missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  layout_id uuid not null references public.layouts (id) on delete cascade,
  name text not null,
  -- The natural-language brief handed to the planner. Null for manual plans.
  brief text,
  plan jsonb not null default '{"steps": []}'::jsonb
    check (jsonb_typeof(plan) = 'object'),
  source text not null check (source in ('ai', 'manual')),
  -- Provenance for AI-generated plans; null when source = 'manual'.
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);

comment on table public.missions is
  'Step plans for a layout, either LLM-generated or hand-written.';

create index missions_user_id_created_at_idx
  on public.missions (user_id, created_at desc);
create index missions_layout_id_idx on public.missions (layout_id);

alter table public.missions enable row level security;

create policy missions_select_own on public.missions
  for select to authenticated
  using (user_id = auth.uid());

create policy missions_insert_own on public.missions
  for insert to authenticated
  with check (user_id = auth.uid());

create policy missions_update_own on public.missions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy missions_delete_own on public.missions
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------

-- There is deliberately no `frames` column and there must never be one
-- (CLAUDE.md rule 6). `layout + mission + seed` fully determines a run, so
-- playback recomputes frames on demand. Persisting them would let stored frames
-- drift from the simulator that produced them.
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mission_id uuid not null references public.missions (id) on delete cascade,
  -- Present from day one, unused in v1. Reserves the slot for stochastic
  -- events without a later signature change.
  seed integer not null default 0,
  status text not null check (status in ('success', 'failed')),
  ticks integer not null check (ticks >= 0),
  distance numeric not null check (distance >= 0),
  battery_end numeric not null check (battery_end between 0 and 100),
  -- { stepIndex, code, detail } — null when status = 'success'.
  failure jsonb check (failure is null or jsonb_typeof(failure) = 'object'),
  log jsonb not null default '[]'::jsonb check (jsonb_typeof(log) = 'array'),
  -- Cached postmortem so reopening a failed run does not re-bill the LLM.
  postmortem jsonb
    check (postmortem is null or jsonb_typeof(postmortem) = 'object'),
  created_at timestamptz not null default now(),
  -- A failed run carries a failure object; a successful one does not.
  constraint runs_failure_matches_status check (
    (status = 'failed' and failure is not null)
    or (status = 'success' and failure is null)
  )
);

comment on table public.runs is
  'Persisted simulation results. Frames are never stored: playback recomputes them from layout + mission + seed.';

create index runs_user_id_created_at_idx
  on public.runs (user_id, created_at desc);
create index runs_mission_id_created_at_idx
  on public.runs (mission_id, created_at desc);

alter table public.runs enable row level security;

create policy runs_select_own on public.runs
  for select to authenticated
  using (user_id = auth.uid());

create policy runs_insert_own on public.runs
  for insert to authenticated
  with check (user_id = auth.uid());

create policy runs_update_own on public.runs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy runs_delete_own on public.runs
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Data API grants
-- ---------------------------------------------------------------------------

-- New tables in `public` are not auto-exposed to the Data API roles (see the
-- `auto_expose_new_tables` note in supabase/config.toml). Without these grants
-- every request fails with `permission denied for table ...` instead of being
-- filtered by RLS.
--
-- `anon` is granted nothing: unauthenticated callers have no business reaching
-- these tables at all. RLS is the second lock, not the only one.
grant select, insert, update, delete on table public.layouts to authenticated;
grant select, insert, update, delete on table public.missions to authenticated;
grant select, insert, update, delete on table public.runs to authenticated;
